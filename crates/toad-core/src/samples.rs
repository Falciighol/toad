//! Which requests a run keeps for the analysis: per endpoint, every failure up to a cap per
//! kind, the slowest N, and a uniform random sample (reservoir). Decisions are cheap and made
//! when the response headers arrive, so bodies are only buffered for requests that may be kept.

use crate::models::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

#[derive(Debug, Clone, Copy)]
pub struct SamplePolicy {
    pub failures: usize,
    pub slowest: usize,
    pub random: usize,
    pub body_bytes: usize,
    pub run_bytes: u64,
    pub bodies: bool,
    /// Keep everything (Try once).
    pub all: bool,
}

impl From<&Settings> for SamplePolicy {
    fn from(s: &Settings) -> Self {
        SamplePolicy {
            failures: s.sample_failures as usize,
            slowest: s.sample_slowest as usize,
            random: s.sample_random as usize,
            body_bytes: s.sample_body_kb as usize * 1024,
            run_bytes: u64::from(s.sample_run_mb) * 1024 * 1024,
            bodies: s.sample_bodies,
            all: false,
        }
    }
}

impl Default for SamplePolicy {
    fn default() -> Self {
        (&Settings::default()).into()
    }
}

impl SamplePolicy {
    pub fn capture_all() -> Self {
        SamplePolicy { all: true, body_bytes: 256 * 1024, run_bytes: u64::MAX, ..Default::default() }
    }
}

#[derive(Default)]
struct StepSamples {
    failures: HashMap<String, Vec<Sample>>,
    /// Ascending by latency.
    slow: Vec<Sample>,
    random: Vec<Sample>,
}

pub struct Sampler {
    pub policy: SamplePolicy,
    steps: Vec<Mutex<StepSamples>>,
    seen: Vec<AtomicU64>,
    /// Smallest latency in each full slowest-N set (µs); 0 while not full.
    slow_floor: Vec<AtomicU64>,
    next_id: AtomicU64,
    bytes: AtomicU64,
    truncated: AtomicBool,
    all: Mutex<Vec<Sample>>,
}

/// Decided at response time, before the body is read.
#[derive(Debug, Clone, Copy, Default)]
pub struct Intent {
    /// Reservoir slot this request holds, if any.
    pub random_slot: Option<usize>,
    pub buffer_body: bool,
}

fn approx_size(s: &Sample) -> u64 {
    let r = s.request.as_ref().map_or(0, |r| r.body.len() + r.url.len() + r.headers.iter().map(|h| h.name.len() + h.value.len()).sum::<usize>());
    let p = s.response.as_ref().map_or(0, |r| r.body.len() + r.headers.iter().map(|h| h.name.len() + h.value.len()).sum::<usize>());
    (r + p + 400) as u64
}

impl Sampler {
    pub fn new(policy: SamplePolicy, steps: usize) -> Self {
        Sampler {
            policy,
            steps: (0..steps).map(|_| Mutex::new(StepSamples::default())).collect(),
            seen: (0..steps).map(|_| AtomicU64::new(0)).collect(),
            slow_floor: (0..steps).map(|_| AtomicU64::new(0)).collect(),
            next_id: AtomicU64::new(1),
            bytes: AtomicU64::new(0),
            truncated: AtomicBool::new(false),
            all: Mutex::new(Vec::new()),
        }
    }

    fn full(&self) -> bool {
        self.bytes.load(Ordering::Relaxed) >= self.policy.run_bytes
    }

    /// Called when response headers arrive (or a request fails before them).
    pub fn intent(&self, step: usize, likely_failed: bool, elapsed_us: u64, rng: &mut fastrand::Rng) -> Intent {
        if self.policy.all {
            return Intent { random_slot: None, buffer_body: true };
        }
        let n = self.seen[step].fetch_add(1, Ordering::Relaxed);
        let cap = self.policy.random as u64;
        let random_slot = if cap == 0 {
            None
        } else if n < cap {
            Some(n as usize)
        } else {
            let j = rng.u64(..=n);
            (j < cap).then_some(j as usize)
        };
        let floor = self.slow_floor[step].load(Ordering::Relaxed);
        let maybe_slow = self.policy.slowest > 0 && (floor == 0 || elapsed_us >= floor / 2);
        let buffer_body = self.policy.bodies && !self.full() && (likely_failed || random_slot.is_some() || maybe_slow);
        Intent { random_slot, buffer_body }
    }

    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Would a finished request with this result be kept? Avoids building unneeded samples.
    pub fn wants(&self, step: usize, fail_key: Option<&str>, latency_us: u64, intent: &Intent) -> Option<SampleReason> {
        if self.policy.all {
            return Some(SampleReason::Try);
        }
        if self.full() {
            if fail_key.is_some() {
                self.truncated.store(true, Ordering::Relaxed);
            }
            return None;
        }
        if let Some(k) = fail_key {
            let s = self.steps[step].lock().unwrap();
            if s.failures.get(k).is_none_or(|v| v.len() < self.policy.failures) {
                return Some(SampleReason::Failure);
            }
            self.truncated.store(true, Ordering::Relaxed);
        }
        let floor = self.slow_floor[step].load(Ordering::Relaxed);
        if self.policy.slowest > 0 && (floor == 0 || latency_us > floor) {
            return Some(SampleReason::Slow);
        }
        intent.random_slot.map(|_| SampleReason::Random)
    }

    pub fn submit(&self, step: usize, reason: SampleReason, fail_key: Option<&str>, intent: &Intent, mut sample: Sample) {
        sample.reason = reason.clone();
        let size = approx_size(&sample);
        if self.policy.all {
            self.all.lock().unwrap().push(sample);
            return;
        }
        let mut s = self.steps[step].lock().unwrap();
        let added = match reason {
            SampleReason::Failure => {
                let v = s.failures.entry(fail_key.unwrap_or("other").to_string()).or_default();
                if v.len() < self.policy.failures {
                    v.push(sample);
                    size
                } else {
                    0
                }
            }
            SampleReason::Slow => {
                let pos = s.slow.partition_point(|x| x.latency_us < sample.latency_us);
                s.slow.insert(pos, sample);
                let mut removed = 0;
                if s.slow.len() > self.policy.slowest {
                    removed = approx_size(&s.slow.remove(0));
                }
                if s.slow.len() >= self.policy.slowest {
                    self.slow_floor[step].store(s.slow[0].latency_us.max(1), Ordering::Relaxed);
                }
                size.saturating_sub(removed)
            }
            SampleReason::Random | SampleReason::Try => {
                let slot = intent.random_slot.unwrap_or(0);
                if slot < s.random.len() {
                    let old = std::mem::replace(&mut s.random[slot], sample);
                    size.saturating_sub(approx_size(&old))
                } else {
                    s.random.push(sample);
                    size
                }
            }
        };
        self.bytes.fetch_add(added, Ordering::Relaxed);
    }

    pub fn info(&self) -> SamplesInfo {
        SamplesInfo {
            count: 0,
            bytes: self.bytes.load(Ordering::Relaxed),
            truncated: self.truncated.load(Ordering::Relaxed),
            bodies: self.policy.bodies,
        }
    }

    /// Every kept sample, oldest first (a sample kept for two reasons appears once).
    pub fn into_samples(self) -> Vec<Sample> {
        let mut out = self.all.into_inner().unwrap();
        for m in self.steps {
            let s = m.into_inner().unwrap();
            out.extend(s.failures.into_values().flatten());
            out.extend(s.slow);
            out.extend(s.random);
        }
        out.sort_by_key(|s| (s.t_ms, s.id));
        out.dedup_by_key(|s| s.id);
        out
    }
}

/// Replaces known secret values in captured text.
#[derive(Debug, Clone, Default)]
pub struct Redactor {
    secrets: Vec<String>,
    pub enabled: bool,
}

impl Redactor {
    pub fn new(enabled: bool) -> Self {
        Redactor { secrets: vec![], enabled }
    }

    pub fn add(&mut self, v: &str) {
        if self.enabled && v.len() >= 4 && !self.secrets.iter().any(|s| s == v) {
            self.secrets.push(v.to_string());
        }
    }

    pub fn apply(&self, s: &mut String, extra: &[String]) {
        if !self.enabled {
            return;
        }
        for secret in self.secrets.iter().chain(extra.iter().filter(|e| e.len() >= 4)) {
            if s.contains(secret.as_str()) {
                *s = s.replace(secret.as_str(), crate::spec::REDACTED);
            }
        }
    }

    pub fn sample(&self, sample: &mut Sample, extra: &[String]) {
        if !self.enabled {
            return;
        }
        let headers = |hs: &mut Vec<crate::spec::KeyValue>| {
            for h in hs.iter_mut() {
                if crate::spec::is_sensitive_header(&h.name) {
                    h.value = crate::spec::REDACTED.into();
                } else {
                    self.apply(&mut h.value, extra);
                }
            }
        };
        if let Some(r) = &mut sample.request {
            self.apply(&mut r.url, extra);
            self.apply(&mut r.body, extra);
            headers(&mut r.headers);
        }
        if let Some(r) = &mut sample.response {
            self.apply(&mut r.body, extra);
            headers(&mut r.headers);
        }
        for h in &mut sample.redirects {
            self.apply(&mut h.url, extra);
        }
        for v in &mut sample.vars {
            self.apply(&mut v.value, extra);
        }
        for e in sample.extracted.iter_mut() {
            if e.secret {
                if let Some(v) = &mut e.value {
                    *v = crate::spec::REDACTED.into();
                }
            } else if let Some(v) = &mut e.value {
                self.apply(v, extra);
            }
        }
        for c in &mut sample.checks {
            self.apply(&mut c.actual, extra);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: u64, latency_us: u64) -> Sample {
        Sample {
            id, step_id: "s".into(), scenario_id: None, reason: SampleReason::Random, outcome: StepOutcome::Ok, error_kind: None,
            error: None, t_ms: id, vu: 0, iteration: 0, latency_us, raw_us: latency_us, ttfb_us: 0, request: None, response: None,
            redirects: vec![], vars: vec![], checks: vec![], extracted: vec![], trace: vec![], branch: None,
        }
    }

    #[test]
    fn caps_per_reason() {
        let policy = SamplePolicy { failures: 2, slowest: 3, random: 4, body_bytes: 100, run_bytes: u64::MAX, bodies: true, all: false };
        let s = Sampler::new(policy, 1);
        let mut rng = fastrand::Rng::with_seed(9);
        for i in 0..1000u64 {
            let failed = i % 10 == 0;
            let latency = (i * 7919) % 1000;
            let intent = s.intent(0, failed, latency, &mut rng);
            let key = failed.then_some("status:500");
            if let Some(reason) = s.wants(0, key, latency, &intent) {
                s.submit(0, reason, key, &intent, sample(s.next_id(), latency));
            }
        }
        let info = s.info();
        assert!(info.truncated, "failures beyond the cap are reported");
        let all = s.into_samples();
        let by = |r: SampleReason| all.iter().filter(|x| x.reason == r).count();
        assert_eq!(by(SampleReason::Failure), 2);
        assert_eq!(by(SampleReason::Slow), 3);
        assert!((1..=4).contains(&by(SampleReason::Random)), "{}", by(SampleReason::Random));
        let mut slow: Vec<u64> = all.iter().filter(|x| x.reason == SampleReason::Slow).map(|x| x.latency_us).collect();
        slow.sort_unstable();
        assert_eq!(slow, [997, 998, 999]);
    }

    #[test]
    fn run_cap_stops_collection() {
        let policy = SamplePolicy { failures: 100, slowest: 0, random: 0, body_bytes: 100, run_bytes: 1000, bodies: true, all: false };
        let s = Sampler::new(policy, 1);
        let mut rng = fastrand::Rng::with_seed(1);
        let mut kept = 0;
        for i in 0..50 {
            let intent = s.intent(0, true, 0, &mut rng);
            if let Some(r) = s.wants(0, Some("x"), 0, &intent) {
                s.submit(0, r, Some("x"), &intent, sample(i, 0));
                kept += 1;
            }
        }
        assert!(kept < 10 && s.info().truncated);
    }

    #[test]
    fn redaction() {
        let mut r = Redactor::new(true);
        r.add("supersecret");
        r.add("abc");
        let mut s = sample(1, 0);
        s.request = Some(SampleRequest {
            method: "GET".into(), url: "http://x/?k=supersecret".into(),
            headers: vec![crate::spec::KeyValue { name: "Authorization".into(), value: "Bearer t".into(), enabled: true }],
            body: "abc tok-1234".into(), body_bytes: 0, truncated: false, binary: false,
        });
        r.sample(&mut s, &["tok-1234".into()]);
        let req = s.request.unwrap();
        assert_eq!(req.url, "http://x/?k=[redacted]");
        assert_eq!(req.headers[0].value, "[redacted]");
        assert_eq!(req.body, "abc [redacted]", "values under 4 chars aren't treated as secrets");
    }
}
