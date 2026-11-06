//! Tiny configurable HTTP server for tests and benchmarks (shared by
//! `examples/mock_server.rs` and `tests/engine_it.rs`).
#![allow(dead_code)]

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct MockConfig {
    pub delay_ms: u64,
    pub jitter_ms: u64,
    pub error_rate: f64,
    pub body_bytes: usize,
    pub seed: u64,
}

impl Default for MockConfig {
    fn default() -> Self {
        MockConfig { delay_ms: 0, jitter_ms: 0, error_rate: 0.0, body_bytes: 64, seed: 0x5EED }
    }
}

struct Mock {
    cfg: MockConfig,
    rng: AtomicU64,
    body: Vec<u8>,
}

impl Mock {
    /// splitmix64 over an atomic counter: lock-free and good enough for test noise.
    fn rand(&self) -> u64 {
        let mut z = self.rng.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn unit(&self) -> f64 {
        (self.rand() >> 11) as f64 / (1u64 << 53) as f64
    }

    async fn wait(&self) {
        let jitter = if self.cfg.jitter_ms > 0 {
            (self.unit() * 2.0 - 1.0) * self.cfg.jitter_ms as f64
        } else {
            0.0
        };
        let ms = (self.cfg.delay_ms as f64 + jitter).max(0.0);
        if ms > 0.0 {
            tokio::time::sleep(Duration::from_secs_f64(ms / 1000.0)).await;
        }
    }
}

async fn any(State(m): State<Arc<Mock>>) -> Response {
    m.wait().await;
    if m.cfg.error_rate > 0.0 && m.unit() < m.cfg.error_rate {
        return (StatusCode::INTERNAL_SERVER_ERROR, "mock error").into_response();
    }
    ([(header::CONTENT_TYPE, "text/plain")], m.body.clone()).into_response()
}

async fn status(Path(code): Path<u16>) -> Response {
    StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST).into_response()
}

async fn redirect(Path(n): Path<u32>) -> Response {
    let to = if n == 0 { "/".to_string() } else { format!("/redirect/{}", n - 1) };
    (StatusCode::FOUND, [(header::LOCATION, to)]).into_response()
}

pub fn router(cfg: MockConfig) -> Router {
    let body = vec![b'x'; cfg.body_bytes];
    let state = Arc::new(Mock { rng: AtomicU64::new(cfg.seed), cfg, body });
    Router::new()
        .route("/status/{code}", get(status))
        .route("/redirect/{n}", get(redirect))
        .fallback(any)
        .with_state(state)
}

pub async fn serve(listener: tokio::net::TcpListener, cfg: MockConfig) {
    axum::serve(listener, router(cfg)).await.expect("mock server");
}

/// Bind to an ephemeral loopback port and serve in the background.
pub async fn spawn(cfg: MockConfig) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(serve(listener, cfg));
    addr
}
