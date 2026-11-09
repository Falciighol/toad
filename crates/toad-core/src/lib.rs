//! Toad core: the load engine, test model, templating, metrics and shared types.
//! Has no Tauri dependency; everything here is unit-testable.

pub mod cookies;
pub mod data;
pub mod engine;
pub mod export;
pub mod extract;
pub mod http;
pub mod limiter;
pub mod metrics;
pub mod models;
pub mod safety;
pub mod samples;
pub mod spec;
pub mod template;
pub mod validate;

pub use engine::{run, send_step, try_flow, EngineError, RunOptions, RunResult};
pub use models::*;
pub use spec::*;

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
