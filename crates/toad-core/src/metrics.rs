//! Lock-striped metric shards and the aggregator that merges them.
//!
//! Virtual users record into a shard picked by their id; the only other party that takes a
//! shard's lock is the aggregator, 4× per second. Each shard holds whole-run histograms
//! (3 significant figures) plus one smaller set per request step (2 significant figures,
//! bounded ranges) so per-endpoint numbers don't multiply memory: a 20-step test with 20
//! shards costs about 30 MB instead of the ~500 MB that full-precision per-step histograms
//! would. Per-step percentiles are accurate to ±1%.

use crate::models::*;
use hdrhistogram::Histogram;
use std::sync::Mutex;

/// Corrected latency is measured from the scheduled send time, so it can exceed the
/// request timeout by an arbitrary backlog. Bounded at 1 hour (values above saturate).
const CORRECTED_MAX_US: u64 = 3_600_000_000;
/// Per-step corrected latency saturates at 10 minutes.
const STEP_CORRECTED_MAX_US: u64 = 600_000_000;

pub fn new_histogram(max_us: u64) -> Histogram<u64> {
    new_histogram_sig(max_us, 3)
}

pub fn new_histogram_sig(max_us: u64, sig: u8) -> Histogram<u64> {
    Histogram::new_with_bounds(1, max_us.max(1_000), sig).expect("valid histogram bounds")
}

/// Upper bounds (µs) of the fixed log buckets used for per-second endpoint histograms:
/// 64 buckets, ×1.3 apart, from 100 µs to ~25 min. Brushing a time window in the UI merges
/// these to estimate window percentiles (±15% within a bucket, interpolated).
pub const BUCKETS: [u64; 64] = {
    let mut b = [0u64; 64];
    let mut v = 100.0f64;
    let mut i = 0;
    while i < 64 {
        b[i] = v as u64;
        v *= 1.3;
        i += 1;
    }
    b
};

pub fn bucket_of(us: u64) -> usize {
    BUCKETS.partition_point(|&b| b < us).min(BUCKETS.len() - 1)
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
        let raw_max = u64::from(timeout_ms).max(1) * 1000 * 2;
        Hists { corrected: new_histogram(CORRECTED_MAX_US), raw: new_histogram(raw_max), ttfb: new_histogram(raw_max) }
    }

    pub fn new_step(timeout_ms: u32) -> Self {
        let raw_max = u64::from(timeout_ms).max(1) * 1000 * 2;
        Hists {
            corrected: new_histogram_sig(STEP_CORRECTED_MAX_US, 2),
            raw: new_histogram_sig(raw_max, 2),
            ttfb: new_histogram_sig(raw_max, 2),
        }
    }

    pub fn add(&mut self, other: &Hists) {
        // Same bounds on both sides, so addition cannot fail.
        let _ = self.corrected.add(&other.corrected);
        let _ = self.raw.add(&other.raw);
        let _ = self.ttfb.add(&other.ttfb);
    }

    pub fn reset(&mut self) {
        for h in [&mut self.corrected, &mut self.raw, &mut self.ttfb] {
            if !h.is_empty() {
                h.reset();
            }
        }
    }

    fn record(&mut self, corrected_us: u64, raw_us: u64, ttfb_us: u64) {
        self.corrected.saturating_record(corrected_us.max(1));
        self.raw.saturating_record(raw_us.max(1));
        self.ttfb.saturating_record(ttfb_us.max(1));
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
        Counters { ok: 0, failed: 0, cancelled: 0, bytes: 0, status: vec![0; 600], errors: [0; ErrorKind::ALL.len()], fd_exhausted: false }
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
        self.status.iter().enumerate().filter(|(_, c)| **c > 0).map(|(code, &count)| StatusCount { code: code as u16, count }).collect()
    }

    pub fn error_counts(&self) -> Vec<ErrorCount> {
        ErrorKind::ALL
            .iter()
            .filter(|k| self.errors[k.index()] > 0)
            .map(|&kind| ErrorCount { kind, count: self.errors[kind.index()] })
            .collect()
    }

    fn record(&mut self, o: &Outcome) {
        match *o {
            Outcome::Response { status, success, error, bytes, .. } => {
                self.bytes += bytes;
                if let Some(c) = self.status.get_mut(usize::from(status)) {
                    *c += 1;
                }
                if success {
                    self.ok += 1;
                } else {
                    self.failed += 1;
                    self.errors[error.unwrap_or(ErrorKind::Status).index()] += 1;
                }
            }
            Outcome::Error { kind, status, bytes, fd_exhausted } => {
                self.failed += 1;
                self.bytes += bytes;
                self.errors[kind.index()] += 1;
                self.fd_exhausted |= fd_exhausted;
                if let Some(c) = status.and_then(|s| self.status.get_mut(usize::from(s))) {
                    *c += 1;
                }
            }
            Outcome::Cancelled => self.cancelled += 1,
        }
    }
}

/// What happened to one request that was sent.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Outcome {
    /// A full response was received (any status). `success` reflects the success range and
    /// failing checks; `error` says why it failed (`Status` or `Check`).
    Response { status: u16, success: bool, error: Option<ErrorKind>, corrected_us: u64, raw_us: u64, ttfb_us: u64, bytes: u64 },
    /// Transport-level failure. Latency is not recorded for these.
    Error { kind: ErrorKind, status: Option<u16>, bytes: u64, fd_exhausted: bool },
    /// Aborted by Stop after the grace period.
    Cancelled,
}

/// A request step that was not sent, or a rule that failed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Event {
    Skipped,
    NotTaken,
    Blocked,
    BuildError,
    /// A check (by index) failed.
    CheckFailed(usize),
    /// The request had at least one failed check.
    ChecksFailed,
    ExtractFailed(usize),
}

#[derive(Debug, Clone, Default)]
pub struct StepExtra {
    pub skipped: u64,
    pub not_taken: u64,
    pub blocked: u64,
    pub build_errors: u64,
    pub check_failures: u64,
    pub extract_failures: u64,
    pub checks: Vec<u64>,
    pub extracts: Vec<u64>,
}

impl StepExtra {
    fn new(checks: usize, extracts: usize) -> Self {
        StepExtra { checks: vec![0; checks], extracts: vec![0; extracts], ..Default::default() }
    }

    fn add(&mut self, o: &StepExtra) {
        self.skipped += o.skipped;
        self.not_taken += o.not_taken;
        self.blocked += o.blocked;
        self.build_errors += o.build_errors;
        self.check_failures += o.check_failures;
        self.extract_failures += o.extract_failures;
        for (a, b) in self.checks.iter_mut().zip(&o.checks) {
            *a += b;
        }
        for (a, b) in self.extracts.iter_mut().zip(&o.extracts) {
            *a += b;
        }
    }

    fn reset(&mut self) {
        let (c, e) = (self.checks.len(), self.extracts.len());
        *self = StepExtra::new(c, e);
    }

    fn record(&mut self, ev: Event) {
        match ev {
            Event::Skipped => self.skipped += 1,
            Event::NotTaken => self.not_taken += 1,
            Event::Blocked => self.blocked += 1,
            Event::BuildError => self.build_errors += 1,
            Event::ChecksFailed => self.check_failures += 1,
            Event::CheckFailed(i) => {
                if let Some(c) = self.checks.get_mut(i) {
                    *c += 1;
                }
            }
            Event::ExtractFailed(i) => {
                self.extract_failures += 1;
                if let Some(c) = self.extracts.get_mut(i) {
                    *c += 1;
                }
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct StepMetrics {
    pub hists: Hists,
    pub counts: Counters,
    pub extra: StepExtra,
}

impl StepMetrics {
    fn new(shape: &StepShape, timeout_ms: u32) -> Self {
        StepMetrics { hists: Hists::new_step(timeout_ms), counts: Counters::default(), extra: StepExtra::new(shape.checks, shape.extracts) }
    }

    fn add(&mut self, o: &StepMetrics) {
        self.hists.add(&o.hists);
        self.counts.add(&o.counts);
        self.extra.add(&o.extra);
    }

    fn reset(&mut self) {
        self.hists.reset();
        self.counts.reset();
        self.extra.reset();
    }
}

#[derive(Debug, Clone)]
pub struct ScenMetrics {
    pub iterations: u64,
    pub iterations_failed: u64,
    pub dropped: u64,
    pub duration: Histogram<u64>,
}

impl ScenMetrics {
    fn new() -> Self {
        ScenMetrics { iterations: 0, iterations_failed: 0, dropped: 0, duration: new_histogram_sig(CORRECTED_MAX_US, 2) }
    }

    fn add(&mut self, o: &ScenMetrics) {
        self.iterations += o.iterations;
        self.iterations_failed += o.iterations_failed;
        self.dropped += o.dropped;
        let _ = self.duration.add(&o.duration);
    }

    fn reset(&mut self) {
        self.iterations = 0;
        self.iterations_failed = 0;
        self.dropped = 0;
        if !self.duration.is_empty() {
            self.duration.reset();
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct StepShape {
    pub checks: usize,
    pub extracts: usize,
    pub timeout_ms: u32,
}

#[derive(Debug, Clone, Default)]
pub struct Shape {
    pub steps: Vec<StepShape>,
    pub scenarios: usize,
    pub timeout_ms: u32,
}

#[derive(Debug)]
pub struct Shard {
    pub hists: Hists,
    pub counts: Counters,
    pub steps: Vec<StepMetrics>,
    pub scens: Vec<ScenMetrics>,
}

impl Shard {
    pub fn new(shape: &Shape) -> Self {
        Shard {
            hists: Hists::new(shape.timeout_ms),
            counts: Counters::default(),
            steps: shape.steps.iter().map(|s| StepMetrics::new(s, s.timeout_ms)).collect(),
            scens: (0..shape.scenarios).map(|_| ScenMetrics::new()).collect(),
        }
    }

    pub fn record(&mut self, step: usize, o: Outcome) {
        if let Outcome::Response { corrected_us, raw_us, ttfb_us, .. } = o {
            self.hists.record(corrected_us, raw_us, ttfb_us);
            if let Some(s) = self.steps.get_mut(step) {
                s.hists.record(corrected_us, raw_us, ttfb_us);
            }
        }
        self.counts.record(&o);
        if let Some(s) = self.steps.get_mut(step) {
            s.counts.record(&o);
        }
    }

    /// Record into the step's metrics only (setup/teardown requests).
    pub fn record_step_only(&mut self, step: usize, o: Outcome) {
        if let Some(s) = self.steps.get_mut(step) {
            if let Outcome::Response { corrected_us, raw_us, ttfb_us, .. } = o {
                s.hists.record(corrected_us, raw_us, ttfb_us);
            }
            s.counts.record(&o);
        }
    }

    pub fn event(&mut self, step: usize, ev: Event) {
        if let Some(s) = self.steps.get_mut(step) {
            s.extra.record(ev);
        }
    }

    pub fn iteration(&mut self, scen: usize, failed: bool, duration_us: u64) {
        if let Some(s) = self.scens.get_mut(scen) {
            s.iterations += 1;
            s.iterations_failed += u64::from(failed);
            s.duration.saturating_record(duration_us.max(1));
        }
    }

    pub fn dropped(&mut self, scen: usize, n: u64) {
        if let Some(s) = self.scens.get_mut(scen) {
            s.dropped += n;
        }
    }

    fn reset(&mut self) {
        self.hists.reset();
        self.counts.reset();
        self.steps.iter_mut().for_each(StepMetrics::reset);
        self.scens.iter_mut().for_each(ScenMetrics::reset);
    }
}

pub fn shard_count(concurrency: u32) -> usize {
    let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
    (concurrency as usize).clamp(1, cores * 2)
}

#[derive(Debug)]
pub struct Shards {
    shards: Vec<Mutex<Shard>>,
}

impl Shards {
    pub fn new(count: usize, shape: &Shape) -> Self {
        Shards { shards: (0..count.max(1)).map(|_| Mutex::new(Shard::new(shape))).collect() }
    }

    pub fn len(&self) -> usize {
        self.shards.len()
    }

    pub fn is_empty(&self) -> bool {
        self.shards.is_empty()
    }

    pub fn with<R>(&self, vu: usize, f: impl FnOnce(&mut Shard) -> R) -> R {
        let shard = &self.shards[vu % self.shards.len()];
        f(&mut shard.lock().unwrap_or_else(|p| p.into_inner()))
    }

    pub fn record(&self, vu: usize, step: usize, o: Outcome) {
        self.with(vu, |s| s.record(step, o));
    }

    pub fn event(&self, vu: usize, step: usize, ev: Event) {
        self.with(vu, |s| s.event(step, ev));
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

/// Quantiles for the percentile spectrum chart (more resolution in the tail).
const SPECTRUM_Q: [f64; 22] =
    [0.0, 0.1, 0.25, 0.5, 0.75, 0.8, 0.85, 0.9, 0.925, 0.95, 0.96, 0.97, 0.98, 0.99, 0.993, 0.995, 0.997, 0.999, 0.9995, 0.9999, 0.99999, 1.0];

pub fn spectrum(h: &Histogram<u64>) -> Vec<SpectrumPoint> {
    if h.is_empty() {
        return vec![];
    }
    SPECTRUM_Q.iter().map(|&q| SpectrumPoint { q, us: if q >= 1.0 { h.max() } else { h.value_at_quantile(q) } }).collect()
}

/// Sparse [bucket, count] pairs of a histogram's recorded values.
pub fn sparse_buckets(h: &Histogram<u64>) -> Vec<u32> {
    if h.is_empty() {
        return vec![];
    }
    let mut counts = [0u64; BUCKETS.len()];
    for v in h.iter_recorded() {
        counts[bucket_of(v.value_iterated_to())] += v.count_at_value();
    }
    counts.iter().enumerate().filter(|(_, c)| **c > 0).flat_map(|(i, &c)| [i as u32, c.min(u64::from(u32::MAX)) as u32]).collect()
}

/// Aggregated views of one step.
#[derive(Debug)]
pub struct StepAgg {
    pub interval: StepMetrics,
    pub second: StepMetrics,
    pub cumulative: StepMetrics,
    pub verdict: StepMetrics,
    pub series: Vec<StepPoint>,
}

#[derive(Debug)]
pub struct ScenAgg {
    pub interval: ScenMetrics,
    pub second_iterations: u64,
    pub cumulative: ScenMetrics,
    /// Busy virtual users, set by the engine before each second closes.
    pub vus_now: u32,
    pub series: Vec<ScenarioPoint>,
}

/// Merges shards on every tick into interval, per-second, cumulative and verdict views.
#[derive(Debug)]
pub struct Aggregator {
    pub interval: Hists,
    pub interval_counts: Counters,
    second: Hists,
    second_counts: Counters,
    pub cumulative: Hists,
    pub cumulative_counts: Counters,
    /// Cumulative excluding the warm-up (what thresholds judge at the end).
    pub verdict: Hists,
    pub verdict_counts: Counters,
    pub steps: Vec<StepAgg>,
    pub scens: Vec<ScenAgg>,
    pub series: Vec<SecondPoint>,
    scratch: Shard,
}

impl Aggregator {
    pub fn new(shape: &Shape) -> Self {
        let step = |s: &StepShape| StepMetrics::new(s, s.timeout_ms);
        Aggregator {
            interval: Hists::new(shape.timeout_ms),
            interval_counts: Counters::default(),
            second: Hists::new(shape.timeout_ms),
            second_counts: Counters::default(),
            cumulative: Hists::new(shape.timeout_ms),
            cumulative_counts: Counters::default(),
            verdict: Hists::new(shape.timeout_ms),
            verdict_counts: Counters::default(),
            steps: shape
                .steps
                .iter()
                .map(|s| StepAgg { interval: step(s), second: step(s), cumulative: step(s), verdict: step(s), series: Vec::new() })
                .collect(),
            scens: (0..shape.scenarios)
                .map(|_| ScenAgg { interval: ScenMetrics::new(), second_iterations: 0, cumulative: ScenMetrics::new(), vus_now: 0, series: Vec::new() })
                .collect(),
            series: Vec::new(),
            scratch: Shard::new(shape),
        }
    }

    /// Drain every shard into the interval view and fold it into the other views.
    /// `in_verdict` is false during the warm-up.
    pub fn collect(&mut self, shards: &Shards, in_verdict: bool) {
        self.scratch.reset();
        for shard in &shards.shards {
            let mut s = shard.lock().unwrap_or_else(|p| p.into_inner());
            self.scratch.hists.add(&s.hists);
            self.scratch.counts.add(&s.counts);
            for (a, b) in self.scratch.steps.iter_mut().zip(&s.steps) {
                a.add(b);
            }
            for (a, b) in self.scratch.scens.iter_mut().zip(&s.scens) {
                a.add(b);
            }
            s.reset();
        }
        self.interval.reset();
        self.interval_counts.reset();
        self.interval.add(&self.scratch.hists);
        self.interval_counts.add(&self.scratch.counts);
        self.second.add(&self.interval);
        self.second_counts.add(&self.interval_counts);
        self.cumulative.add(&self.interval);
        self.cumulative_counts.add(&self.interval_counts);
        if in_verdict {
            self.verdict.add(&self.interval);
            self.verdict_counts.add(&self.interval_counts);
        }
        for (agg, s) in self.steps.iter_mut().zip(&self.scratch.steps) {
            agg.interval.reset();
            agg.interval.add(s);
            agg.second.add(s);
            agg.cumulative.add(s);
            if in_verdict {
                agg.verdict.add(s);
            }
        }
        for (agg, s) in self.scens.iter_mut().zip(&self.scratch.scens) {
            agg.interval.reset();
            agg.interval.add(s);
            agg.second_iterations += s.iterations;
            agg.cumulative.add(s);
        }
    }

    /// Close the current second (or partial second, `elapsed_s` < 1) into series points.
    pub fn close_second(&mut self, t_s: u32, elapsed_s: f64, vus: u32) -> SecondPoint {
        let c = percentiles(&self.second.corrected);
        let r = percentiles(&self.second.raw);
        let iterations = self.scens.iter().map(|s| s.second_iterations).sum();
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
            vus,
            iterations,
        };
        self.second.reset();
        self.second_counts.reset();
        for s in &mut self.scens {
            s.series.push(ScenarioPoint { t_s, vus: s.vus_now, iterations: s.second_iterations });
            s.second_iterations = 0;
        }
        for step in &mut self.steps {
            let p = percentiles(&step.second.hists.corrected);
            step.series.push(StepPoint {
                t_s,
                ok: step.second.counts.ok,
                failed: step.second.counts.failed,
                p50: p.p50,
                p95: p.p95,
                p99: p.p99,
                hist: sparse_buckets(&step.second.hists.corrected),
            });
            step.second.reset();
        }
        self.series.push(point.clone());
        point
    }

    /// Close the final partial second. A short tail (< 0.5 s, e.g. the drain after the
    /// deadline) is folded into the previous point so a handful of completions over a few ms
    /// doesn't show up as a huge RPS spike. Returns the new point, or `None` when folded.
    pub fn close_tail(&mut self, t_s: u32, elapsed_s: f64, vus: u32) -> Option<SecondPoint> {
        if elapsed_s >= 0.5 || self.series.is_empty() {
            return Some(self.close_second(t_s, elapsed_s, vus));
        }
        let c = &self.second_counts;
        if let Some(last) = self.series.last_mut() {
            let completed = (c.ok + c.failed) as f64;
            last.rps = (last.rps + completed) / (1.0 + elapsed_s);
            last.ok += c.ok;
            last.failed += c.failed;
            last.bytes += c.bytes;
            last.iterations += self.scens.iter().map(|s| s.second_iterations).sum::<u64>();
        }
        for step in &mut self.steps {
            if let Some(last) = step.series.last_mut() {
                last.ok += step.second.counts.ok;
                last.failed += step.second.counts.failed;
            }
            step.second.reset();
        }
        self.second.reset();
        self.second_counts.reset();
        for s in &mut self.scens {
            if let Some(last) = s.series.last_mut() {
                last.iterations += s.second_iterations;
            }
            s.second_iterations = 0;
        }
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
    /// `target` is the scheduled rate for the second (open-model, single-request iterations
    /// only). Only call this for seconds in the steady `Running` phase.
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
        let flat = (point.raw_p50 as f64) <= baseline as f64 * 1.25 && (point.raw_p50 as f64) >= baseline as f64 * 0.75;
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
        Outcome::Response { status, success, error: (!success).then_some(ErrorKind::Status), corrected_us: us, raw_us: us, ttfb_us: us / 2, bytes: 10 }
    }

    fn shape(steps: usize) -> Shape {
        Shape { steps: vec![StepShape { checks: 2, extracts: 1, timeout_ms: 10_000 }; steps], scenarios: 1, timeout_ms: 10_000 }
    }

    #[test]
    fn percentile_math_uniform() {
        let mut h = new_histogram(10_000_000);
        for v in 1..=10_000u64 {
            h.record(v).unwrap();
        }
        let p = percentiles(&h);
        let close = |a: u64, b: u64| (a as f64 - b as f64).abs() / b as f64 <= 0.001;
        assert!(close(p.p50, 5000), "{}", p.p50);
        assert!(close(p.p90, 9000), "{}", p.p90);
        assert!(close(p.p99, 9900), "{}", p.p99);
        assert_eq!(p.min, 1);
        assert!(close(p.max, 10_000));
        assert_eq!(p.count, 10_000);
        assert_eq!(percentiles(&new_histogram(1000)), Percentiles::default());
        let s = spectrum(&h);
        assert_eq!(s.len(), SPECTRUM_Q.len());
        assert!(s.windows(2).all(|w| w[0].us <= w[1].us));
    }

    #[test]
    fn merging_shards_equals_single_histogram() {
        let sh = shape(1);
        let shards = Shards::new(4, &sh);
        let mut single = Hists::new(10_000);
        for i in 0..4000u64 {
            let us = 100 + (i * 7919) % 50_000;
            shards.record(i as usize, 0, resp(us, 200, true));
            single.corrected.record(us).unwrap();
        }
        let mut agg = Aggregator::new(&sh);
        agg.collect(&shards, true);
        assert_eq!(percentiles(&agg.interval.corrected), percentiles(&single.corrected));
        assert_eq!(agg.cumulative_counts.ok, 4000);
        assert_eq!(agg.steps[0].cumulative.counts.ok, 4000);
        // Per-step percentiles are within 1% of the full-precision ones.
        let (a, b) = (percentiles(&agg.steps[0].cumulative.hists.corrected).p99, percentiles(&single.corrected).p99);
        assert!((a as f64 - b as f64).abs() / b as f64 <= 0.01, "{a} vs {b}");
        agg.collect(&shards, true);
        assert!(agg.interval.corrected.is_empty());
        assert_eq!(agg.cumulative.corrected.len(), 4000);
    }

    #[test]
    fn steps_events_and_series() {
        let sh = shape(2);
        let shards = Shards::new(2, &sh);
        shards.record(0, 0, resp(1000, 200, true));
        shards.record(1, 1, resp(2000, 503, false));
        shards.record(0, 1, Outcome::Error { kind: ErrorKind::Timeout, status: None, bytes: 0, fd_exhausted: false });
        shards.record(1, 0, Outcome::Cancelled);
        shards.event(0, 1, Event::Skipped);
        shards.event(0, 1, Event::CheckFailed(1));
        shards.event(0, 1, Event::ChecksFailed);
        shards.event(1, 0, Event::ExtractFailed(0));
        shards.with(0, |s| s.iteration(0, true, 5000));
        shards.with(1, |s| s.dropped(0, 1));
        let mut agg = Aggregator::new(&sh);
        agg.collect(&shards, false);
        let c = &agg.cumulative_counts;
        assert_eq!((c.ok, c.failed, c.cancelled), (1, 2, 1));
        assert_eq!(agg.verdict_counts.completed(), 0, "warm-up excluded from the verdict view");
        let s1 = &agg.steps[1].cumulative;
        assert_eq!((s1.counts.failed, s1.extra.skipped, s1.extra.checks[1], s1.extra.check_failures), (2, 1, 1, 1));
        assert_eq!(agg.steps[0].cumulative.extra.extracts, vec![1]);
        let sc = &agg.scens[0].cumulative;
        assert_eq!((sc.iterations, sc.iterations_failed, sc.dropped), (1, 1, 1));
        let p = agg.close_second(1, 1.0, 7);
        assert_eq!((p.rps, p.vus, p.iterations), (3.0, 7, 1));
        assert_eq!(agg.steps[0].series[0].ok, 1);
        assert_eq!(agg.steps[0].series[0].hist, vec![bucket_of(1000) as u32, 1]);
    }

    #[test]
    fn buckets() {
        assert_eq!(BUCKETS[0], 100);
        assert!(BUCKETS[63] > 600_000_000);
        assert_eq!(bucket_of(1), 0);
        assert_eq!(bucket_of(100), 0);
        assert_eq!(bucket_of(101), 1);
        assert_eq!(bucket_of(u64::MAX), 63);
    }

    #[test]
    fn short_tail_folds_into_previous_second() {
        let sh = shape(1);
        let shards = Shards::new(1, &sh);
        let mut agg = Aggregator::new(&sh);
        for _ in 0..100 {
            shards.record(0, 0, resp(1000, 200, true));
        }
        agg.collect(&shards, true);
        agg.close_second(1, 1.0, 1);
        for _ in 0..5 {
            shards.record(0, 0, resp(1000, 200, true));
        }
        agg.collect(&shards, true);
        assert_eq!(agg.close_tail(2, 0.02, 1), None);
        assert_eq!(agg.series.len(), 1);
        assert_eq!(agg.series[0].ok, 105);
        assert_eq!(agg.steps[0].series[0].ok, 105);
        assert!((agg.series[0].rps - 105.0 / 1.02).abs() < 1e-9);
        shards.record(0, 0, resp(1000, 200, true));
        agg.collect(&shards, true);
        assert!(agg.close_tail(2, 0.7, 1).is_some());
        assert_eq!(agg.series.len(), 2);
    }

    #[test]
    fn scenario_series_records_vus_and_folds_tail_iterations() {
        let sh = shape(1);
        let mut agg = Aggregator::new(&sh);
        agg.scens[0].vus_now = 7;
        agg.scens[0].second_iterations = 12;
        agg.close_second(1, 1.0, 7);
        agg.scens[0].second_iterations = 2;
        assert_eq!(agg.close_tail(2, 0.1, 0), None);
        assert_eq!(agg.scens[0].series, vec![ScenarioPoint { t_s: 1, vus: 7, iterations: 14 }]);
    }

    #[test]
    fn bottleneck_detection() {
        let pt = |rps: f64, p50: u64| SecondPoint {
            t_s: 1, rps, ok: 0, failed: 0, bytes: 0, p50, p95: 0, p99: 0, raw_p50: p50, raw_p95: 0, raw_p99: 0, vus: 0, iterations: 0,
        };
        let mut d = BottleneckDetector::default();
        assert_eq!(d.observe(&pt(3000.0, 10_000), 5000.0, 100), None);
        assert_eq!(d.observe(&pt(3000.0, 10_500), 5000.0, 100), None);
        assert_eq!(d.observe(&pt(3000.0, 9_800), 5000.0, 100), Some(Warning::ToadBottleneck));
        assert_eq!(d.observe(&pt(3000.0, 20_000), 5000.0, 100), None);
        let mut d = BottleneckDetector::default();
        assert_eq!(d.observe(&pt(1000.0, 10_000), 5000.0, 10), Some(Warning::ConcurrencyTooLow { needed: 60 }));
    }
}
