//! Toad core: the load engine, rate limiter, metrics and shared models.
//! Has no Tauri dependency; everything here is unit-testable.

pub mod engine;
pub mod export;
pub mod limiter;
pub mod metrics;
pub mod models;
pub mod safety;

pub use engine::{run, EngineError, RunOptions};
pub use models::*;

/// Raise the soft open-file limit towards the hard limit (Unix). Returns the new limit.
pub fn raise_fd_limit() -> Option<u64> {
    #[cfg(unix)]
    {
        rlimit::increase_nofile_limit(u64::MAX).ok()
    }
    #[cfg(not(unix))]
    {
        None
    }
}
