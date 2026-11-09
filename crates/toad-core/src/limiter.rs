//! Load profiles: how many virtual users run (closed model) or how many iterations start per
//! second (open model) at time t, as piecewise-linear stages. Open-model rates entered per
//! minute or hour are converted to per second here, so everything downstream counts seconds.
//!
//! The open model is a virtual-schedule limiter (GCRA, a token bucket of size 1): slot `k` is
//! assigned the send time `t_k` at which the k-th token becomes available. Because every
//! iteration knows its *intended* start, the first request's latency is measured from it,
//! which corrects for coordinated omission. If the target stalls, `t_k` stays in the past and
//! free virtual users start back-to-back until they catch up, exactly like wrk2.

use crate::spec::{Executor, RateUnit, Stage};

#[derive(Debug, Clone, Copy, PartialEq)]
struct Seg {
    t0: f64,
    t1: f64,
    v0: f64,
    v1: f64,
    /// Slots due before t0.
    area0: f64,
}

impl Seg {
    fn value(&self, t: f64) -> f64 {
        let len = self.t1 - self.t0;
        if len <= 0.0 {
            return self.v1;
        }
        self.v0 + (self.v1 - self.v0) * ((t - self.t0) / len).clamp(0.0, 1.0)
    }

    fn area_to(&self, t: f64) -> f64 {
        let x = (t - self.t0).clamp(0.0, self.t1 - self.t0);
        let len = self.t1 - self.t0;
        if len <= 0.0 {
            return 0.0;
        }
        self.v0 * x + (self.v1 - self.v0) * x * x / (2.0 * len)
    }
}

/// A piecewise-linear profile over [0, duration].
#[derive(Debug, Clone, PartialEq)]
pub struct Profile {
    segs: Vec<Seg>,
}

impl Profile {
    pub fn constant(value: f64, secs: f64) -> Profile {
        Profile::staged(value, &[(secs, value)])
    }

    /// From `start`, move linearly to each stage's target over its duration.
    pub fn staged(start: f64, stages: &[(f64, f64)]) -> Profile {
        let mut segs = Vec::new();
        let (mut t, mut v, mut area) = (0.0, start, 0.0);
        for &(dur, target) in stages {
            let s = Seg { t0: t, t1: t + dur.max(0.0), v0: v, v1: target, area0: area };
            area += s.area_to(s.t1);
            segs.push(s);
            t += dur.max(0.0);
            v = target;
        }
        if segs.is_empty() {
            segs.push(Seg { t0: 0.0, t1: 0.0, v0: start, v1: start, area0: 0.0 });
        }
        Profile { segs }
    }

    pub fn from_executor(e: &Executor) -> Profile {
        let stages = |st: &[Stage], u: RateUnit| st.iter().map(|s| (f64::from(s.duration_secs), u.per_second(f64::from(s.target)))).collect::<Vec<_>>();
        match e {
            Executor::Vus { vus, duration_secs } => Profile::constant(f64::from(*vus), f64::from(*duration_secs)),
            Executor::RampingVus { start, stages: st } => Profile::staged(f64::from(*start), &stages(st, RateUnit::Second)),
            Executor::Rate { rate, rate_unit, duration_secs, .. } => Profile::constant(rate_unit.per_second(f64::from(*rate)), f64::from(*duration_secs)),
            Executor::RampingRate { start, stages: st, rate_unit, .. } => Profile::staged(rate_unit.per_second(f64::from(*start)), &stages(st, *rate_unit)),
            Executor::Iterations { vus, max_duration_secs, .. } => Profile::constant(f64::from(*vus), f64::from(*max_duration_secs)),
        }
    }

    pub fn duration(&self) -> f64 {
        self.segs.last().map_or(0.0, |s| s.t1)
    }

    pub fn value_at(&self, t: f64) -> f64 {
        if t >= self.duration() {
            return self.segs.last().map_or(0.0, |s| s.v1);
        }
        self.segs.iter().find(|s| t < s.t1).map_or(0.0, |s| s.value(t))
    }

    /// Slots due in [0, t) (the integral of the rate).
    pub fn slots_by(&self, t: f64) -> f64 {
        let t = t.clamp(0.0, self.duration());
        match self.segs.iter().find(|s| t <= s.t1) {
            Some(s) => s.area0 + s.area_to(t),
            None => self.segs.last().map_or(0.0, |s| s.area0 + s.area_to(s.t1)),
        }
    }

    /// Seconds from start at which slot `k` (0-based) is due; `None` past the end.
    pub fn slot_time(&self, k: u64) -> Option<f64> {
        let k = k as f64;
        for s in &self.segs {
            let total = s.area0 + s.area_to(s.t1);
            if k >= total {
                continue;
            }
            let rem = k - s.area0;
            let len = s.t1 - s.t0;
            let a = (s.v1 - s.v0) / (2.0 * len);
            let x = if a.abs() < 1e-12 {
                if s.v0 <= 0.0 {
                    continue;
                }
                rem / s.v0
            } else {
                // a·x² + v0·x − rem = 0
                let disc = (s.v0 * s.v0 + 4.0 * a * rem).max(0.0);
                (-s.v0 + disc.sqrt()) / (2.0 * a)
            };
            return Some(s.t0 + x.clamp(0.0, len));
        }
        None
    }

    /// Points for drawing the plan: (t, value) at every stage boundary.
    pub fn points(&self) -> Vec<(f64, f64)> {
        let mut out = vec![(0.0, self.segs.first().map_or(0.0, |s| s.v0))];
        out.extend(self.segs.iter().map(|s| (s.t1, s.v1)));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_rate_is_evenly_spaced() {
        let p = Profile::constant(100.0, 10.0);
        assert_eq!(p.slot_time(0), Some(0.0));
        assert!((p.slot_time(100).unwrap() - 1.0).abs() < 1e-9);
        assert!((p.slot_time(250).unwrap() - 2.5).abs() < 1e-9);
        assert_eq!(p.slot_time(1000), None, "past the end");
        assert_eq!(p.value_at(5.0), 100.0);
    }

    #[test]
    fn ramp_matches_integral_and_inverse() {
        let p = Profile::staged(1.0, &[(10.0, 1000.0), (5.0, 1000.0), (5.0, 0.0)]);
        assert!((p.value_at(5.0) - 500.5).abs() < 1e-9);
        assert!((p.value_at(12.0) - 1000.0).abs() < 1e-9);
        assert!((p.value_at(17.5) - 500.0).abs() < 1e-9);
        assert!((p.slots_by(10.0) - 5005.0).abs() < 1e-6);
        assert!((p.slots_by(20.0) - (5005.0 + 5000.0 + 2500.0)).abs() < 1e-6);
        for k in [0u64, 1, 10, 500, 4_000, 5_004, 5_005, 9_000, 12_000] {
            let t = p.slot_time(k).unwrap();
            assert!((p.slots_by(t) - k as f64).abs() < 1e-6, "k={k} t={t}");
        }
        let mut prev = -1.0;
        for k in 0..12_000 {
            let t = p.slot_time(k).unwrap();
            assert!(t > prev);
            prev = t;
        }
        assert_eq!(p.slot_time(12_600), None);
        assert_eq!(p.duration(), 20.0);
        assert_eq!(p.points(), vec![(0.0, 1.0), (10.0, 1000.0), (15.0, 1000.0), (20.0, 0.0)]);
    }

    #[test]
    fn zero_rate_segments_are_skipped() {
        let p = Profile::staged(0.0, &[(5.0, 0.0), (5.0, 10.0)]);
        let t = p.slot_time(0).unwrap();
        assert!((5.0..7.0).contains(&t), "{t}");
    }

    #[test]
    fn executors() {
        let p = Profile::from_executor(&Executor::RampingVus { start: 0, stages: vec![Stage { duration_secs: 10, target: 100 }] });
        assert_eq!(p.value_at(5.0), 50.0);
        assert_eq!(p.duration(), 10.0);
    }

    #[test]
    fn rate_units_become_per_second() {
        let p = Profile::from_executor(&Executor::Rate { rate: 30, rate_unit: RateUnit::Minute, duration_secs: 120, max_vus: 1 });
        assert_eq!(p.value_at(10.0), 0.5);
        assert!((p.slot_time(1).unwrap() - 2.0).abs() < 1e-9, "30/min is one every 2 s");
        assert!((p.slots_by(120.0) - 60.0).abs() < 1e-9);
        let p = Profile::from_executor(&Executor::RampingRate { start: 0, stages: vec![Stage { duration_secs: 3600, target: 3600 }], rate_unit: RateUnit::Hour, max_vus: 1 });
        assert_eq!(p.value_at(3600.0), 1.0);
        assert!((p.slots_by(3600.0) - 1800.0).abs() < 1e-6);
    }
}
