//! Tiny configurable HTTP server for tests and benchmarks (shared by
//! `examples/mock_server.rs` and `tests/engine_it.rs`).
#![allow(dead_code)]

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any as any_method, get, post};
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

/// Delay, jitter and error injection for every route.
async fn chaos(State(m): State<Arc<Mock>>, req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    m.wait().await;
    if m.cfg.error_rate > 0.0 && m.unit() < m.cfg.error_rate {
        return (StatusCode::INTERNAL_SERVER_ERROR, "mock error").into_response();
    }
    next.run(req).await
}

async fn any(State(m): State<Arc<Mock>>) -> Response {
    ([(header::CONTENT_TYPE, "text/plain")], m.body.clone()).into_response()
}

async fn status(Path(code): Path<u16>) -> Response {
    StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST).into_response()
}

async fn redirect(Path(n): Path<u32>) -> Response {
    let to = if n == 0 { "/".to_string() } else { format!("/redirect/{}", n - 1) };
    (StatusCode::FOUND, [(header::LOCATION, to)]).into_response()
}

/// POST /login with `{"user": "..."}` (or a form): a token in the body and a session cookie.
async fn login(headers: HeaderMap, body: Bytes) -> Response {
    let text = String::from_utf8_lossy(&body).to_string();
    let user = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("user").and_then(|u| u.as_str()).map(str::to_string))
        .or_else(|| text.split('&').find_map(|kv| kv.strip_prefix("user=").map(str::to_string)))
        .unwrap_or_default();
    if user.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing user").into_response();
    }
    let _ = headers;
    let body = serde_json::json!({ "token": format!("tok-{user}"), "user": { "id": 42, "name": user } }).to_string();
    (
        [(header::CONTENT_TYPE, "application/json".to_string()), (header::SET_COOKIE, format!("sid=s-{user}; Path=/; HttpOnly"))],
        body,
    )
        .into_response()
}

/// GET /orders: needs `Authorization: Bearer tok-…`.
async fn orders(headers: HeaderMap) -> Response {
    let ok = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with("Bearer tok-"));
    if !ok {
        return (StatusCode::UNAUTHORIZED, "no token").into_response();
    }
    ([(header::CONTENT_TYPE, "application/json")], r#"{"orders":[{"id":1,"total":9.5},{"id":2,"total":20}],"count":2}"#).into_response()
}

/// GET /me: needs the `sid` cookie.
async fn me(headers: HeaderMap) -> Response {
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    match cookie.split(';').find_map(|c| c.trim().strip_prefix("sid=")) {
        Some(sid) => ([(header::CONTENT_TYPE, "application/json")], format!(r#"{{"sid":"{sid}"}}"#)).into_response(),
        None => (StatusCode::UNAUTHORIZED, "no session").into_response(),
    }
}

/// Any method on /echo: what was received, as JSON.
async fn echo(method: Method, headers: HeaderMap, RawQuery(q): RawQuery, body: Bytes) -> Response {
    let hs: serde_json::Map<String, serde_json::Value> =
        headers.iter().map(|(k, v)| (k.as_str().to_string(), serde_json::Value::String(v.to_str().unwrap_or("").to_string()))).collect();
    let out = serde_json::json!({
        "method": method.as_str(),
        "query": q.unwrap_or_default(),
        "headers": hs,
        "body": String::from_utf8_lossy(&body),
        "bytes": body.len(),
    });
    ([(header::CONTENT_TYPE, "application/json")], out.to_string()).into_response()
}

async fn xml() -> Response {
    ([(header::CONTENT_TYPE, "application/xml")], r#"<?xml version="1.0"?><order id="o-7"><item sku="a">Apple</item><item sku="b">Pear</item></order>"#).into_response()
}

/// Sets a cookie on the redirect itself, then lands on /me.
async fn redirect_cookie() -> Response {
    (StatusCode::FOUND, [(header::LOCATION, "/me"), (header::SET_COOKIE, "sid=from-redirect; Path=/")]).into_response()
}

pub fn router(cfg: MockConfig) -> Router {
    let body = vec![b'x'; cfg.body_bytes];
    let state = Arc::new(Mock { rng: AtomicU64::new(cfg.seed), cfg, body });
    Router::new()
        .route("/status/{code}", get(status))
        .route("/redirect/{n}", get(redirect))
        .route("/login", post(login))
        .route("/orders", get(orders))
        .route("/me", get(me))
        .route("/echo", any_method(echo))
        .route("/xml", get(xml))
        .route("/redirect-cookie", get(redirect_cookie))
        .fallback(any)
        .layer(axum::middleware::from_fn_with_state(state.clone(), chaos))
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
