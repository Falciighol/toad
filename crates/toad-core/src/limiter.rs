//! Request dispatching: tickets, the RPS schedule, and the ramp-up math.
//!
//! The RPS cap is a virtual-schedule limiter (GCRA, i.e. a token bucket of size 1):
//! ticket `k` is assigned the send time `t_k` at which the k-th token becomes
//! available. Because every request knows its *intended* send time, latency can be
//! measured from it, which corrects for coordinated omission. If Toad or the server
//! falls behind, `t_k` stays in the past and workers send back-to-back until they
//! catch up, exactly like wrk2.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::time::Instant;

/// Target send rate over time: linear from `start_rate` to `rate` over `ramp_secs`, then flat.
#[derive(Debug, Clone, Copy)]
pub struct Schedule {
    rate: f64,
    start_rate: f64,
    ramp_secs: f64,
}

impl Schedule {
    pub fn new(rate: u32, ramp_secs: Option<u32>) -> Self {
        let rate = f64::from(rate.max(1));
        Schedule {
            rate,
            start_rate: rate.min(1.0),
            ramp_secs: f64::from(ramp_secs.unwrap_or(0)),
        }
    }

    pub fn rate_at(&self, t: f64) -> f64 {
        if t >= self.ramp_secs {
            self.rate
        } else {
            self.start_rate + (self.rate - self.start_rate) * t.max(0.0) / self.ramp_secs
        }
    }

    /// Number of send slots due in `[0, t)` (the integral of `rate_at`).
    pub fn slots_by(&self, t: f64) -> f64 {
        let t = t.max(0.0);
        let (r0, r, ramp) = (self.start_rate, self.rate, self.ramp_secs);
        if t < ramp {
            r0 * t + (r - r0) * t * t / (2.0 * ramp)
        } else {
            ramp * (r0 + r) / 2.0 + (t - ramp) * r
        }
    }

    /// Seconds from start at which slot `k` (0-based) is due. Inverse of [`Self::slots_by`].
    pub fn slot_time(&self, k: u64) -> f64 {
        let k = k as f64;
        let (r0, r, ramp) = (self.start_rate, self.rate, self.ramp_secs);
        let ramp_slots = ramp * (r0 + r) / 2.0;
        if k >= ramp_slots {
            return ramp + (k - ramp_slots) / r;
        }
        // Solve a·t² + r0·t − k = 0 with a = (r − r0) / 2T.
        let a = (r - r0) / (2.0 * ramp);
        if a.abs() < f64::EPSILON {
            k / r0
        } else {
            (-r0 + (r0 * r0 + 4.0 * a * k).sqrt()) / (2.0 * a)
        }
    }
}

/// Start offset for worker `i` of `n` when ramping without an RPS cap: active workers
/// grow linearly from 1 at t=0 to `n` at t=`ramp_secs`.
pub fn worker_start_offset(i: u32, n: u32, ramp_secs: Option<u32>) -> Duration {
    match ramp_secs {
        Some(r) if r > 0 && n > 1 => Duration::from_secs_f64(f64::from(r) * f64::from(i) / f64::from(n - 1)),
        _ => Duration::ZERO,
    }
}

/// Active workers at time `t` for an uncapped ramp (mirrors [`worker_start_offset`]).
pub fn active_workers_at(t: f64, n: u32, ramp_secs: Option<u32>) -> u32 {
    match ramp_secs {
        Some(r) if r > 0 && n > 1 => {
            let k = (t.max(0.0) * f64::from(n - 1) / f64::from(r)).floor() as u32 + 1;
            k.min(n)
        }
        _ => n,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ticket {
    pub seq: u64,
    /// Intended send time; `None` in the closed (uncapped) model.
    pub scheduled: Option<Instant>,
}

/// Hands out tickets until the stop condition is reached. Lock-free.
#[derive(Debug)]
pub struct Dispatcher {
    next: AtomicU64,
    start: Instant,
    max_requests: Option<u64>,
    deadline: Option<Instant>,
    schedule: Option<Schedule>,
}

impl Dispatcher {
    pub fn new(
        start: Instant,
        max_requests: Option<u64>,
        duration: Option<Duration>,
        schedule: Option<Schedule>,
    ) -> Self {
        Dispatcher {
            next: AtomicU64::new(0),
            start,
            max_requests,
            deadline: duration.map(|d| start + d),
            schedule,
        }
    }

    pub fn start(&self) -> Instant {
        self.start
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    pub fn schedule(&self) -> Option<&Schedule> {
        self.schedule.as_ref()
    }

    /// Next ticket, or `None` once the request budget or the duration is used up.
    pub fn next(&self) -> Option<Ticket> {
        let seq = self.next.fetch_add(1, Ordering::Relaxed);
        if self.max_requests.is_some_and(|max| seq >= max) {
            return None;
        }
        let scheduled = self
            .schedule
            .map(|s| self.start + Duration::from_secs_f64(s.slot_time(seq)));
        let deadline_check = scheduled.unwrap_or_else(Instant::now);
        if self.deadline.is_some_and(|d| deadline_check >= d) {
            return None;
        }
        Some(Ticket { seq, scheduled })
    }

    /// Tickets handed out so far (may overshoot the budget by the number of workers).
    pub fn issued(&self) -> u64 {
        let n = self.next.load(Ordering::Relaxed);
        self.max_requests.map_or(n, |m| n.min(m))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn flat_schedule_is_evenly_spaced() {
        let s = Schedule::new(100, None);
        assert_eq!(s.slot_time(0), 0.0);
        assert!((s.slot_time(100) - 1.0).abs() < 1e-9);
        assert!((s.slot_time(250) - 2.5).abs() < 1e-9);
    }

    #[test]
    fn ramp_schedule_matches_integral() {
        let s = Schedule::new(1000, Some(10));
        // Rate grows linearly from 1 to 1000 over 10 s.
        assert!((s.rate_at(0.0) - 1.0).abs() < 1e-9);
        assert!((s.rate_at(5.0) - 500.5).abs() < 1e-9);
        assert!((s.rate_at(20.0) - 1000.0).abs() < 1e-9);
        // slot_time is the inverse of slots_by everywhere.
        for k in [0u64, 1, 10, 500, 4_000, 5_004, 5_005, 20_000] {
            let t = s.slot_time(k);
            assert!((s.slots_by(t) - k as f64).abs() < 1e-6, "k={k} t={t}");
        }
        // Slots during ramp: area of the trapezoid = 10 * (1 + 1000) / 2.
        assert!((s.slots_by(10.0) - 5005.0).abs() < 1e-6);
        // Monotonic.
        let mut prev = -1.0;
        for k in 0..6000 {
            let t = s.slot_time(k);
            assert!(t > prev);
            prev = t;
        }
    }

    #[test]
    fn uncapped_ramp_workers() {
        assert_eq!(worker_start_offset(0, 11, Some(10)), Duration::ZERO);
        assert_eq!(worker_start_offset(5, 11, Some(10)), Duration::from_secs(5));
        assert_eq!(worker_start_offset(10, 11, Some(10)), Duration::from_secs(10));
        assert_eq!(worker_start_offset(3, 11, None), Duration::ZERO);
        assert_eq!(active_workers_at(0.0, 11, Some(10)), 1);
        assert_eq!(active_workers_at(4.99, 11, Some(10)), 5);
        assert_eq!(active_workers_at(5.0, 11, Some(10)), 6);
        assert_eq!(active_workers_at(99.0, 11, Some(10)), 11);
        assert_eq!(active_workers_at(0.0, 11, None), 11);
    }

    #[test]
    fn request_budget_is_exact() {
        let d = Dispatcher::new(Instant::now(), Some(3), None, None);
        assert!(d.next().is_some());
        assert!(d.next().is_some());
        assert!(d.next().is_some());
        assert!(d.next().is_none());
        assert_eq!(d.issued(), 3);
    }

    #[test]
    fn capped_duration_stops_at_deadline() {
        let d = Dispatcher::new(Instant::now(), None, Some(Duration::from_secs(2)), Some(Schedule::new(50, None)));
        let mut n = 0;
        while d.next().is_some() {
            n += 1;
        }
        assert_eq!(n, 100);
    }

    /// Rate limiter accuracy: 8 workers pulling tickets for 3 s at 2000 rps (paused clock).
    #[tokio::test(start_paused = true)]
    async fn limiter_accuracy_within_5_percent() {
        let target = 2000.0;
        let start = Instant::now();
        let d = Arc::new(Dispatcher::new(start, None, None, Some(Schedule::new(2000, None))));
        let window = Duration::from_secs(3);
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let d = d.clone();
            tasks.push(tokio::spawn(async move {
                let mut sent = 0u64;
                loop {
                    let t = d.next().unwrap();
                    let at = t.scheduled.unwrap();
                    if at >= start + window {
                        return sent;
                    }
                    tokio::time::sleep_until(at).await;
                    // Simulated work so workers interleave.
                    tokio::time::sleep(Duration::from_micros(300)).await;
                    sent += 1;
                }
            }));
        }
        let mut total = 0;
        for t in tasks {
            total += t.await.unwrap();
        }
        let rps = total as f64 / window.as_secs_f64();
        assert!((rps - target).abs() / target < 0.05, "rps={rps}");
    }

    /// With a ramp, the number of requests sent in the first T seconds follows the trapezoid.
    #[tokio::test(start_paused = true)]
    async fn ramp_send_counts() {
        let start = Instant::now();
        let s = Schedule::new(1000, Some(4));
        let d = Dispatcher::new(start, None, None, Some(s));
        let mut in_ramp = 0u64;
        loop {
            let t = d.next().unwrap().scheduled.unwrap();
            if t >= start + Duration::from_secs(4) {
                break;
            }
            in_ramp += 1;
        }
        let expected = 4.0 * (1.0 + 1000.0) / 2.0;
        assert!((in_ramp as f64 - expected).abs() / expected < 0.01, "{in_ramp}");
    }
}
