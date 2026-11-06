//! Lock-striped metric shards and the aggregator that merges them.
//!
//! Workers record into a shard they own (worker `i` → shard `i % shard_count`); the
//! only other party that ever takes a shard's lock is the aggregator, 4× per second.
//! Shards are striped rather than strictly per-worker because an HDR histogram with
//! 3 significant figures and a 1 h range is ~200 KB: 1000 workers × 3 histograms
//! would cost hundreds of MB for no benefit (only `available_parallelism` workers can
//! record at the same instant). With 4 shards per core the lock is effectively private.

use crate::models::{ErrorCount, ErrorKind, Percentiles, SecondPoint, StatusCount, Warning};
use hdrhistogram::Histogram;
use std::sync::Mutex;

/// Corrected latency is measured from the scheduled send time, so it can exceed the
/// request timeout by an arbitrary backlog. Bounded at 1 hour (values above saturate).
const CORRECTED_MAX_US: u64 = 3_600_000_000;

pub fn new_histogram(max_us: u64) -> Histogram<u64> {
    Histogram::new_with_bounds(1, max_us.max(1_000), 3).expect("valid histogram bounds")
}

/// Corrected latency, raw service time, and time-to-first-byte.
#[derive(Debug, Clone)]
pub struct Hists {
    pub corrected: Histogram<u64>,
    pub raw: Histogram<u64>,
    pub ttfb: Histogram<u64>,
}

impl Hists {
    pub fn new(timeout_ms: u32) -> Self {
        // Raw/TTFB can't exceed the timeout by much; leave 2× headroom for timer slop.
        let raw_max = u64::from(timeout_ms) * 1000 * 2;
        Hists {
            corrected: new_histogram(CORRECTED_MAX_US),
            raw: new_histogram(raw_max),
            ttfb: new_histogram(raw_max),
        }
    }

    pub fn add(&mut self, other: &Hists) {
        // Same bounds on both sides, so addition cannot fail.
        let _ = self.corrected.add(&other.corrected);
        let _ = self.raw.add(&other.raw);
        let _ = self.ttfb.add(&other.ttfb);
    }

    pub fn reset(&mut self) {
        if !self.corrected.is_empty() {
            self.corrected.reset();
        }
        if !self.raw.is_empty() {
            self.raw.reset();
        }
        if !self.ttfb.is_empty() {
            self.ttfb.reset();
        }
    }
}

#[derive(Debug, Clone)]
pub struct Counters {
    pub ok: u64,
    pub failed: u64,
    pub cancelled: u64,
    pub bytes: u64,
    /// Indexed by status code (0..600).
    pub status: Vec<u64>,
    pub errors: [u64; ErrorKind::ALL.len()],
    pub fd_exhausted: bool,
}

impl Default for Counters {
    fn default() -> Self {
        Counters {
            ok: 0,
            failed: 0,
            cancelled: 0,
            bytes: 0,
            status: vec![0; 600],
            errors: [0; ErrorKind::ALL.len()],
            fd_exhausted: false,
        }
    }
}

impl Counters {
    pub fn add(&mut self, o: &Counters) {
        self.ok += o.ok;
        self.failed += o.failed;
        self.cancelled += o.cancelled;
        self.bytes += o.bytes;
        for (a, b) in self.status.iter_mut().zip(&o.status) {
            *a += b;
        }
        for (a, b) in self.errors.iter_mut().zip(&o.errors) {
            *a += b;
        }
        self.fd_exhausted |= o.fd_exhausted;
    }

    pub fn reset(&mut self) {
        self.ok = 0;
        self.failed = 0;
        self.cancelled = 0;
        self.bytes = 0;
        self.status.iter_mut().for_each(|c| *c = 0);
        self.errors = [0; ErrorKind::ALL.len()];
        self.fd_exhausted = false;
    }

    pub fn completed(&self) -> u64 {
        self.ok + self.failed
    }

    pub fn status_counts(&self) -> Vec<StatusCount> {
        self.status
            .iter()
            .enumerate()
            .filter(|(_, c)| **c > 0)
            .map(|(code, &count)| StatusCount { code: code as u16, count })
            .collect()
    }

    pub fn error_counts(&self) -> Vec<ErrorCount> {
        ErrorKind::ALL
            .iter()
            .filter(|k| self.errors[k.index()] > 0)
            .map(|&kind| ErrorCount { kind, count: self.errors[kind.index()] })
            .collect()
    }
}

/// What happened to one request.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Outcome {
    /// A full response was received (any status). `success` reflects the configured range.
    Response { status: u16, success: bool, corrected_us: u64, raw_us: u64, ttfb_us: u64, bytes: u64 },
    /// Transport-level failure. Latency is not recorded for these.
    Error { kind: ErrorKind, status: Option<u16>, bytes: u64, fd_exhausted: bool },
    /// Aborted by Stop after the grace period.
    Cancelled,
}

#[derive(Debug)]
pub struct Shard {
    pub hists: Hists,
    pub counts: Counters,
}

impl Shard {
    pub fn new(timeout_ms: u32) -> Self {
        Shard { hists: Hists::new(timeout_ms), counts: Counters::default() }
    }

    pub fn record(&mut self, outcome: Outcome) {
        match outcome {
            Outcome::Response { status, success, corrected_us, raw_us, ttfb_us, bytes } => {
                self.hists.corrected.saturating_record(corrected_us.max(1));
                self.hists.raw.saturating_record(raw_us.max(1));
                self.hists.ttfb.saturating_record(ttfb_us.max(1));
                self.counts.bytes += bytes;
                if let Some(c) = self.counts.status.get_mut(usize::from(status)) {
                    *c += 1;
                }
                if success {
                    self.counts.ok += 1;
                } else {
                    self.counts.failed += 1;
                    self.counts.errors[ErrorKind::Status.index()] += 1;
                }
            }
            Outcome::Error { kind, status, bytes, fd_exhausted } => {
                self.counts.failed += 1;
                self.counts.bytes += bytes;
                self.counts.errors[kind.index()] += 1;
                self.counts.fd_exhausted |= fd_exhausted;
                if let Some(c) = status.and_then(|s| self.counts.status.get_mut(usize::from(s))) {
                    *c += 1;
                }
            }
            Outcome::Cancelled => self.counts.cancelled += 1,
        }
    }
}

pub fn shard_count(concurrency: u32) -> usize {
    let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
    (concurrency as usize).clamp(1, cores * 4)
}

#[derive(Debug)]
pub struct Shards {
    shards: Vec<Mutex<Shard>>,
}

impl Shards {
    pub fn new(count: usize, timeout_ms: u32) -> Self {
        Shards { shards: (0..count.max(1)).map(|_| Mutex::new(Shard::new(timeout_ms))).collect() }
    }

    pub fn len(&self) -> usize {
        self.shards.len()
    }

    pub fn is_empty(&self) -> bool {
        self.shards.is_empty()
    }

    pub fn record(&self, worker: usize, outcome: Outcome) {
        let shard = &self.shards[worker % self.shards.len()];
        shard.lock().unwrap_or_else(|p| p.into_inner()).record(outcome);
    }
}

pub fn percentiles(h: &Histogram<u64>) -> Percentiles {
    if h.is_empty() {
        return Percentiles::default();
    }
    Percentiles {
        min: h.min(),
        mean: h.mean().round() as u64,
        p50: h.value_at_quantile(0.50),
        p90: h.value_at_quantile(0.90),
        p95: h.value_at_quantile(0.95),
        p99: h.value_at_quantile(0.99),
        max: h.max(),
        count: h.len(),
    }
}

/// Merges shards on every tick into interval, per-second and cumulative views.
#[derive(Debug)]
pub struct Aggregator {
    pub interval: Hists,
    pub interval_counts: Counters,
    second: Hists,
    second_counts: Counters,
    pub cumulative: Hists,
    pub cumulative_counts: Counters,
    pub series: Vec<SecondPoint>,
}

impl Aggregator {
    pub fn new(timeout_ms: u32) -> Self {
        Aggregator {
            interval: Hists::new(timeout_ms),
            interval_counts: Counters::default(),
            second: Hists::new(timeout_ms),
            second_counts: Counters::default(),
            cumulative: Hists::new(timeout_ms),
            cumulative_counts: Counters::default(),
            series: Vec::new(),
        }
    }

    /// Drain every shard into the interval view and fold it into the second/cumulative views.
    pub fn collect(&mut self, shards: &Shards) {
        self.interval.reset();
        self.interval_counts.reset();
        for shard in &shards.shards {
            let mut s = shard.lock().unwrap_or_else(|p| p.into_inner());
            self.interval.add(&s.hists);
            self.interval_counts.add(&s.counts);
            s.hists.reset();
            s.counts.reset();
        }
        self.second.add(&self.interval);
        self.second_counts.add(&self.interval_counts);
        self.cumulative.add(&self.interval);
        self.cumulative_counts.add(&self.interval_counts);
    }

    /// Close the current second (or partial second, `elapsed_s` < 1) into a series point.
    pub fn close_second(&mut self, t_s: u32, elapsed_s: f64) -> SecondPoint {
        let c = percentiles(&self.second.corrected);
        let r = percentiles(&self.second.raw);
        let point = SecondPoint {
            t_s,
            rps: self.second_counts.completed() as f64 / elapsed_s.max(1e-3),
            ok: self.second_counts.ok,
            failed: self.second_counts.failed,
            bytes: self.second_counts.bytes,
            p50: c.p50,
            p95: c.p95,
            p99: c.p99,
            raw_p50: r.p50,
            raw_p95: r.p95,
            raw_p99: r.p99,
        };
        self.second.reset();
        self.second_counts.reset();
        self.series.push(point.clone());
        point
    }

    /// Close the final partial second at the end of a run. A short tail (< 0.5 s, e.g.
    /// the drain after the deadline) is folded into the previous point so a handful of
    /// completions over a few ms doesn't show up as a huge RPS spike. Returns the new
    /// point, or `None` when the tail was folded.
    pub fn close_tail(&mut self, t_s: u32, elapsed_s: f64) -> Option<SecondPoint> {
        if elapsed_s >= 0.5 || self.series.is_empty() {
            return Some(self.close_second(t_s, elapsed_s));
        }
        let c = &self.second_counts;
        if let Some(last) = self.series.last_mut() {
            let completed = (c.ok + c.failed) as f64;
            last.rps = (last.rps + completed) / (1.0 + elapsed_s);
            last.ok += c.ok;
            last.failed += c.failed;
            last.bytes += c.bytes;
        }
        self.second.reset();
        self.second_counts.reset();
        None
    }

    pub fn second_has_data(&self) -> bool {
        self.second_counts.completed() > 0 || self.second_counts.cancelled > 0
    }
}

/// Decides whether Toad (not the server) is limiting throughput. Fed once per second.
#[derive(Debug, Default)]
pub struct BottleneckDetector {
    baseline_raw_p50: Option<u64>,
    streak: u32,
}

impl BottleneckDetector {
    /// `target` is the scheduled RPS for the second (capped runs only). Only call this
    /// for seconds in the steady `Running` phase.
    pub fn observe(&mut self, point: &SecondPoint, target: f64, concurrency: u32) -> Option<Warning> {
        if point.raw_p50 == 0 || target <= 0.0 {
            return None;
        }
        let baseline = *self.baseline_raw_p50.get_or_insert(point.raw_p50);
        let service_s = point.raw_p50 as f64 / 1e6;
        // Little's law: the most this many workers can do at this service time.
        let capacity = f64::from(concurrency) / service_s;
        if capacity < 0.9 * target {
            self.streak = 0;
            let needed = (target * service_s * 1.2).ceil() as u32;
            return Some(Warning::ConcurrencyTooLow { needed });
        }
        let flat = (point.raw_p50 as f64) <= baseline as f64 * 1.25
            && (point.raw_p50 as f64) >= baseline as f64 * 0.75;
        if point.rps < 0.9 * target && flat {
            self.streak += 1;
        } else {
            self.streak = 0;
        }
        (self.streak >= 3).then_some(Warning::ToadBottleneck)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resp(us: u64, status: u16, success: bool) -> Outcome {
        Outcome::Response { status, success, corrected_us: us, raw_us: us, ttfb_us: us / 2, bytes: 10 }
    }

    #[test]
    fn percentile_math_uniform() {
        let mut h = new_histogram(10_000_000);
        for v in 1..=10_000u64 {
            h.record(v).unwrap();
        }
        let p = percentiles(&h);
        // 3 significant figures → relative error ≤ 0.1%.
        let close = |a: u64, b: u64| (a as f64 - b as f64).abs() / b as f64 <= 0.001;
        assert!(close(p.p50, 5000), "{}", p.p50);
        assert!(close(p.p90, 9000), "{}", p.p90);
        assert!(close(p.p99, 9900), "{}", p.p99);
        assert_eq!(p.min, 1);
        assert!(close(p.max, 10_000));
        assert!(close(p.mean, 5000));
        assert_eq!(p.count, 10_000);
        assert_eq!(percentiles(&new_histogram(1000)), Percentiles::default());
    }

    #[test]
    fn merging_shards_equals_single_histogram() {
        let shards = Shards::new(4, 10_000);
        let mut single = Hists::new(10_000);
        for i in 0..4000u64 {
            let us = 100 + (i * 7919) % 50_000;
            shards.record(i as usize, resp(us, 200, true));
            single.corrected.record(us).unwrap();
        }
        let mut agg = Aggregator::new(10_000);
        agg.collect(&shards);
        assert_eq!(percentiles(&agg.interval.corrected), percentiles(&single.corrected));
        assert_eq!(agg.cumulative_counts.ok, 4000);
        // Shards are drained: a second collect yields an empty interval but keeps the cumulative.
        agg.collect(&shards);
        assert!(agg.interval.corrected.is_empty());
        assert_eq!(agg.cumulative.corrected.len(), 4000);
    }

    #[test]
    fn counters_and_series() {
        let shards = Shards::new(2, 1000);
        shards.record(0, resp(1000, 200, true));
        shards.record(1, resp(2000, 503, false));
        shards.record(0, Outcome::Error { kind: ErrorKind::Timeout, status: None, bytes: 0, fd_exhausted: false });
        shards.record(1, Outcome::Cancelled);
        let mut agg = Aggregator::new(1000);
        agg.collect(&shards);
        let c = &agg.cumulative_counts;
        assert_eq!((c.ok, c.failed, c.cancelled), (1, 2, 1));
        assert_eq!(c.status_counts(), vec![StatusCount { code: 200, count: 1 }, StatusCount { code: 503, count: 1 }]);
        assert_eq!(
            c.error_counts(),
            vec![ErrorCount { kind: ErrorKind::Timeout, count: 1 }, ErrorCount { kind: ErrorKind::Status, count: 1 }]
        );
        let p = agg.close_second(1, 1.0);
        assert_eq!(p.rps, 3.0);
        assert_eq!(agg.series.len(), 1);
        assert!(!agg.second_has_data());
    }

    #[test]
    fn short_tail_folds_into_previous_second() {
        let shards = Shards::new(1, 1000);
        let mut agg = Aggregator::new(1000);
        for _ in 0..100 {
            shards.record(0, resp(1000, 200, true));
        }
        agg.collect(&shards);
        agg.close_second(1, 1.0);
        for _ in 0..5 {
            shards.record(0, resp(1000, 200, true));
        }
        agg.collect(&shards);
        assert_eq!(agg.close_tail(2, 0.02), None);
        assert_eq!(agg.series.len(), 1);
        assert_eq!(agg.series[0].ok, 105);
        assert!((agg.series[0].rps - 105.0 / 1.02).abs() < 1e-9);
        // A long tail is its own point.
        shards.record(0, resp(1000, 200, true));
        agg.collect(&shards);
        assert!(agg.close_tail(2, 0.7).is_some());
        assert_eq!(agg.series.len(), 2);
    }

    #[test]
    fn bottleneck_detection() {
        let pt = |rps: f64, p50: u64| SecondPoint {
            t_s: 1, rps, ok: 0, failed: 0, bytes: 0, p50, p95: 0, p99: 0, raw_p50: p50, raw_p95: 0, raw_p99: 0,
        };
        // 100 workers at 10 ms → capacity 10k rps; target 5k achieved only 3k with flat latency.
        let mut d = BottleneckDetector::default();
        assert_eq!(d.observe(&pt(3000.0, 10_000), 5000.0, 100), None);
        assert_eq!(d.observe(&pt(3000.0, 10_500), 5000.0, 100), None);
        assert_eq!(d.observe(&pt(3000.0, 9_800), 5000.0, 100), Some(Warning::ToadBottleneck));
        // Latency doubling means the server is the bottleneck, not Toad.
        assert_eq!(d.observe(&pt(3000.0, 20_000), 5000.0, 100), None);
        // 10 workers at 10 ms → capacity 1000 rps < 5000 target.
        let mut d = BottleneckDetector::default();
        assert_eq!(d.observe(&pt(1000.0, 10_000), 5000.0, 10), Some(Warning::ConcurrencyTooLow { needed: 60 }));
    }
}
