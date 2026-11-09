//! Mock API for trying Toad locally.
//!
//!   cargo run --release --example mock_server -- --port 8787 --delay-ms 20 --jitter-ms 5 --error-rate 0.01
//!
//! Routes: any path → 200 with `--body-bytes` of payload (or 500 at `--error-rate`),
//! `/status/{code}` → that status, `/redirect/{n}` → a chain of n redirects.
//! Flow routes: `POST /login` (`{"user":"ada"}` → a token and a `sid` cookie), `GET /orders`
//! (needs `Authorization: Bearer tok-…`), `GET /me` (needs the cookie), `/echo` (any method:
//! returns what it received as JSON), `GET /xml`, `GET /redirect-cookie`.

#[path = "../tests/common/mock.rs"]
mod mock;

use mock::MockConfig;

fn usage() -> ! {
    eprintln!(
        "usage: mock_server [--port N] [--delay-ms N] [--jitter-ms N] [--error-rate 0..1] [--body-bytes N] [--seed N]"
    );
    std::process::exit(2)
}

#[tokio::main]
async fn main() {
    let mut cfg = MockConfig::default();
    let mut port: u16 = 8787;
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let mut val = || args.next().unwrap_or_else(|| usage());
        match flag.as_str() {
            "--port" => port = val().parse().unwrap_or_else(|_| usage()),
            "--delay-ms" => cfg.delay_ms = val().parse().unwrap_or_else(|_| usage()),
            "--jitter-ms" => cfg.jitter_ms = val().parse().unwrap_or_else(|_| usage()),
            "--error-rate" => cfg.error_rate = val().parse().unwrap_or_else(|_| usage()),
            "--body-bytes" => cfg.body_bytes = val().parse().unwrap_or_else(|_| usage()),
            "--seed" => cfg.seed = val().parse().unwrap_or_else(|_| usage()),
            "-h" | "--help" => usage(),
            _ => usage(),
        }
    }
    if !(0.0..=1.0).contains(&cfg.error_rate) {
        usage();
    }
    toad_core::raise_fd_limit();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.expect("bind");
    println!("mock_server listening on http://127.0.0.1:{port}  {cfg:?}");
    mock::serve(listener, cfg).await;
}
