//! HTTP plumbing: the safety gate (DNS-level host checks and pinning), client sets (mTLS,
//! proxy, pooling), request bodies, and execution with manual redirects so cookies and host
//! checks apply on every hop.

use crate::models::ErrorKind;
use crate::safety::{is_loopback, is_private};
use crate::spec::*;
use std::collections::{HashMap, HashSet};
use std::error::Error as StdError;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// A request to a host that isn't loopback or confirmed. Surfaced as the *blocked* outcome.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0} is not loopback and wasn't confirmed")]
pub struct BlockedHost(pub String);

/// Decides which hosts a run may reach, and pins every name to the addresses it was checked
/// against so DNS rebinding can't redirect the run.
#[derive(Debug, Default)]
pub struct Gate {
    pub approved: HashSet<String>,
    pub private_ok: bool,
    /// Host overrides from the test (and the pre-run resolution of its static hosts).
    pub overrides: HashMap<String, Vec<SocketAddr>>,
    pinned: Mutex<HashMap<String, Vec<SocketAddr>>>,
    /// A proxy is set: the proxy resolves targets, so only names can be checked.
    pub proxied: bool,
}

pub fn normalize_host(h: &str) -> String {
    h.trim_start_matches('[').trim_end_matches(']').trim_end_matches('.').to_ascii_lowercase()
}

impl Gate {
    pub fn new(approved: HashSet<String>, private_ok: bool, overrides: HashMap<String, Vec<SocketAddr>>, proxied: bool) -> Self {
        Gate { approved, private_ok, overrides, pinned: Mutex::new(HashMap::new()), proxied }
    }

    fn addrs_allowed(&self, host: &str, addrs: &[SocketAddr]) -> bool {
        if addrs.is_empty() {
            return false;
        }
        addrs.iter().all(|a| is_loopback(a.ip()))
            || (self.private_ok && addrs.iter().all(|a| is_loopback(a.ip()) || is_private(a.ip())))
            || self.approved.contains(host)
    }

    /// Checks a URL host before sending. IP literals are classified here (DNS never sees
    /// them); names are checked by the resolver, except through a proxy where only an
    /// approved or loopback name may pass.
    pub fn precheck(&self, host: &str) -> Result<(), BlockedHost> {
        let host = normalize_host(host);
        if host == "localhost" || self.approved.contains(&host) || self.overrides.contains_key(&host) {
            return Ok(());
        }
        if let Ok(ip) = host.parse::<IpAddr>() {
            return if self.addrs_allowed(&host, &[SocketAddr::new(ip, 0)]) { Ok(()) } else { Err(BlockedHost(host)) };
        }
        if self.proxied {
            return Err(BlockedHost(host));
        }
        Ok(())
    }

    pub async fn resolve_checked(&self, host: &str) -> Result<Vec<SocketAddr>, Box<dyn StdError + Send + Sync>> {
        let host = normalize_host(host);
        if let Some(a) = self.overrides.get(&host) {
            return Ok(a.clone());
        }
        if let Some(a) = self.pinned.lock().unwrap().get(&host) {
            return Ok(a.clone());
        }
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
        if !self.addrs_allowed(&host, &addrs) {
            return Err(Box::new(BlockedHost(host)));
        }
        self.pinned.lock().unwrap().entry(host).or_insert_with(|| addrs.clone());
        Ok(addrs)
    }
}

#[derive(Clone)]
pub struct GateResolver(pub Arc<Gate>);

impl reqwest::dns::Resolve for GateResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let gate = self.0.clone();
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs = gate.resolve_checked(&host).await?;
            let it: reqwest::dns::Addrs = Box::new(addrs.into_iter());
            Ok(it)
        })
    }
}

/// Matches a client-certificate host pattern: exact, `*.suffix`, or empty (all hosts).
pub fn host_matches(pattern: &str, host: &str) -> bool {
    let p = pattern.trim().to_ascii_lowercase();
    if p.is_empty() {
        return true;
    }
    match p.strip_prefix("*.") {
        Some(suffix) => host.ends_with(&format!(".{suffix}")),
        None => p == host,
    }
}

/// The reqwest clients a run uses: one default, plus one per client certificate.
#[derive(Clone)]
pub struct Clients {
    pub default: reqwest::Client,
    pub certs: Vec<(String, reqwest::Client)>,
}

impl Clients {
    pub fn for_host(&self, host: &str) -> &reqwest::Client {
        self.certs.iter().find(|(p, _)| host_matches(p, host)).map_or(&self.default, |(_, c)| c)
    }
}

pub struct ClientSettings {
    pub conn: ConnectionSpec,
    pub pool_size: usize,
    pub gate: Arc<Gate>,
    /// Loaded client identities, by cert id.
    pub identities: Vec<(String, reqwest::Identity)>,
}

fn proxy_url(p: &ProxySpec) -> String {
    let scheme = match p.kind {
        ProxyKind::Http => "http",
        ProxyKind::Https => "https",
        ProxyKind::Socks5 => "socks5h",
    };
    let addr = p.address.trim();
    if addr.contains("://") { addr.to_string() } else { format!("{scheme}://{addr}") }
}

fn builder(s: &ClientSettings) -> Result<reqwest::ClientBuilder, String> {
    let c = &s.conn;
    let mut b = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .tcp_nodelay(true)
        .user_agent(concat!("toad/", env!("CARGO_PKG_VERSION")))
        .danger_accept_invalid_certs(c.allow_invalid_certs)
        .dns_resolver(Arc::new(GateResolver(s.gate.clone())))
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(if c.keep_alive { s.pool_size.max(1) } else { 0 });
    if c.http == HttpVersion::Http1 {
        b = b.http1_only();
    }
    if c.proxy.enabled && !c.proxy.address.trim().is_empty() {
        let mut proxy = reqwest::Proxy::all(proxy_url(&c.proxy)).map_err(|e| format!("proxy: {e}"))?;
        if !c.proxy.username.is_empty() {
            proxy = proxy.basic_auth(&c.proxy.username, &c.proxy.password);
        }
        if !c.proxy.no_proxy.trim().is_empty() {
            proxy = proxy.no_proxy(reqwest::NoProxy::from_string(&c.proxy.no_proxy));
        }
        b = b.proxy(proxy);
    } else {
        b = b.no_proxy();
    }
    Ok(b)
}

pub fn build_clients(s: &ClientSettings) -> Result<Clients, String> {
    let default = builder(s)?.build().map_err(|e| format!("could not build HTTP client: {e}"))?;
    let mut certs = Vec::new();
    for cert in &s.conn.client_certs {
        let Some((_, id)) = s.identities.iter().find(|(i, _)| i == &cert.id) else { continue };
        let client = builder(s)?.identity(id.clone()).build().map_err(|e| format!("client certificate {}: {e}", cert.cert_name))?;
        certs.push((cert.host.clone(), client));
    }
    Ok(Clients { default, certs })
}

/// Load a PEM client identity (certificate + unencrypted private key).
pub fn load_identity(cert_pem: &[u8], key_pem: Option<&[u8]>) -> Result<reqwest::Identity, String> {
    let mut pem = cert_pem.to_vec();
    if let Some(k) = key_pem {
        pem.push(b'\n');
        pem.extend_from_slice(k);
    }
    let text = String::from_utf8_lossy(&pem);
    if text.contains("ENCRYPTED PRIVATE KEY") || text.contains("Proc-Type: 4,ENCRYPTED") {
        return Err("the private key is encrypted; decrypt it first (openssl pkey -in key.pem -out key-plain.pem)".into());
    }
    if !text.contains("-----BEGIN CERTIFICATE-----") {
        return Err("no PEM certificate found. PKCS#12 (.p12/.pfx) isn't supported; convert it with openssl pkcs12 -in cert.p12 -out cert.pem -nodes".into());
    }
    if !text.contains("PRIVATE KEY-----") {
        return Err("no private key found; add the key file or include it in the certificate file".into());
    }
    reqwest::Identity::from_pem(&pem).map_err(|e| format!("could not read the certificate: {e}"))
}

// ---------- errors ----------

/// Walk an error's source chain, looking inside `io::Error` wrappers too.
pub fn chain_any(err: &(dyn StdError + 'static), f: &dyn Fn(&(dyn StdError + 'static)) -> bool) -> bool {
    let mut cur = Some(err);
    while let Some(e) = cur {
        if f(e) {
            return true;
        }
        if let Some(inner) = e.downcast_ref::<std::io::Error>().and_then(|io| io.get_ref()) {
            if chain_any(inner, f) {
                return true;
            }
        }
        cur = e.source();
    }
    false
}

pub fn is_fd_exhaustion(e: &(dyn StdError + 'static)) -> bool {
    e.downcast_ref::<std::io::Error>()
        .and_then(std::io::Error::raw_os_error)
        // EMFILE / ENFILE on Unix, WSAEMFILE on Windows.
        .is_some_and(|code| if cfg!(windows) { code == 10024 } else { code == 24 || code == 23 })
}

pub fn is_blocked(err: &(dyn StdError + 'static)) -> Option<String> {
    let mut found = None;
    chain_any(err, &|e| e.is::<BlockedHost>());
    let mut cur = Some(err);
    while let Some(e) = cur {
        if let Some(b) = e.downcast_ref::<BlockedHost>() {
            found = Some(b.0.clone());
            break;
        }
        cur = e.source();
    }
    if found.is_none() && chain_any(err, &|e| e.is::<BlockedHost>()) {
        found = Some(String::new());
    }
    found
}

/// Map a reqwest error onto Toad's error taxonomy. Returns (kind, fd_exhausted).
pub fn classify(err: &reqwest::Error) -> (ErrorKind, bool) {
    let fd = chain_any(err, &is_fd_exhaustion);
    let kind = if err.is_timeout() {
        ErrorKind::Timeout
    } else if chain_any(err, &|e| e.to_string().contains("dns error") || e.to_string().contains("failed to lookup")) {
        ErrorKind::Dns
    } else if chain_any(err, &|e| e.is::<rustls::Error>()) {
        ErrorKind::Tls
    } else if err.is_connect() {
        ErrorKind::Connect
    } else if err.is_redirect() {
        ErrorKind::Redirect
    } else if err.is_body() || err.is_decode() {
        ErrorKind::BodyRead
    } else {
        ErrorKind::Other
    };
    (kind, fd)
}

/// A short human message for an error, without reqwest's URL prefix noise.
pub fn describe(err: &reqwest::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut cur = err.source();
    while let Some(e) = cur {
        let s = e.to_string();
        if !parts.iter().any(|p| p.contains(&s)) {
            parts.push(s);
        }
        cur = e.source();
    }
    parts.join(": ")
}

// ---------- bodies ----------

pub fn default_content_type(kind: &BodyKind) -> &'static str {
    match kind {
        BodyKind::Json | BodyKind::Graphql => "application/json",
        BodyKind::Xml => "application/xml",
        BodyKind::Text => "text/plain; charset=utf-8",
        BodyKind::Form => "application/x-www-form-urlencoded",
        BodyKind::Multipart => "multipart/form-data",
        BodyKind::Binary | BodyKind::Raw => "application/octet-stream",
    }
}

pub fn gzip(bytes: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let _ = e.write_all(bytes);
    e.finish().unwrap_or_default()
}

pub fn urlencoded(fields: &[(String, String)]) -> String {
    let mut s = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in fields {
        s.append_pair(k, v);
    }
    s.finish()
}

pub enum MultipartValue {
    Text(String),
    File { name: String, bytes: Arc<Vec<u8>> },
}

pub fn multipart(fields: &[(String, MultipartValue)], boundary: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, v) in fields {
        out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        let name = name.replace('"', "%22");
        match v {
            MultipartValue::Text(t) => {
                out.extend_from_slice(format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes());
                out.extend_from_slice(t.as_bytes());
            }
            MultipartValue::File { name: fname, bytes } => {
                let fname = fname.replace('"', "%22");
                out.extend_from_slice(
                    format!("Content-Disposition: form-data; name=\"{name}\"; filename=\"{fname}\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes(),
                );
                out.extend_from_slice(bytes);
            }
        }
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    out
}

pub fn graphql_body(query: &str, variables: &str) -> Result<String, String> {
    let mut obj = serde_json::Map::new();
    obj.insert("query".into(), serde_json::Value::String(query.to_string()));
    if !variables.trim().is_empty() {
        let v: serde_json::Value = serde_json::from_str(variables).map_err(|e| format!("GraphQL variables aren't valid JSON: {e}"))?;
        obj.insert("variables".into(), v);
    }
    Ok(serde_json::Value::Object(obj).to_string())
}

/// Text for a captured body: UTF-8 if it is, otherwise marked binary.
pub fn body_text(bytes: &[u8], cap: usize) -> (String, bool, bool) {
    let truncated = bytes.len() > cap;
    let slice = &bytes[..bytes.len().min(cap)];
    match std::str::from_utf8(slice) {
        Ok(s) => (s.to_string(), truncated, false),
        Err(e) if e.valid_up_to() + 4 >= slice.len() && truncated => (String::from_utf8_lossy(&slice[..e.valid_up_to()]).into_owned(), truncated, false),
        Err(_) => (format!("{} bytes of binary data", bytes.len()), truncated, true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_rules() {
        let approved: HashSet<String> = ["api.example.com".to_string()].into();
        let g = Gate::new(approved, false, HashMap::new(), false);
        assert!(g.precheck("127.0.0.1").is_ok());
        assert!(g.precheck("[::1]").is_ok());
        assert!(g.precheck("localhost").is_ok());
        assert!(g.precheck("10.0.0.1").is_err());
        assert!(g.precheck("8.8.8.8").is_err());
        assert!(g.precheck("api.example.com").is_ok());
        // Names go to the resolver unless proxied.
        assert!(g.precheck("other.example.com").is_ok());
        let g = Gate::new(HashSet::new(), true, HashMap::new(), true);
        assert!(g.precheck("10.0.0.1").is_ok());
        assert!(g.precheck("other.example.com").is_err());
    }

    #[tokio::test]
    async fn resolver_pins_and_blocks() {
        let g = Gate::new(HashSet::new(), false, HashMap::new(), false);
        let a = g.resolve_checked("localhost").await.unwrap();
        assert!(a.iter().all(|x| x.ip().is_loopback()));
        let mut ov = HashMap::new();
        ov.insert("api.test".to_string(), vec!["127.0.0.1:0".parse().unwrap()]);
        let g = Gate::new(HashSet::new(), false, ov, false);
        assert_eq!(g.resolve_checked("API.test").await.unwrap()[0].ip().to_string(), "127.0.0.1");
    }

    #[test]
    fn bodies() {
        assert_eq!(urlencoded(&[("a b".into(), "c&d".into()), ("e".into(), "ü".into())]), "a+b=c%26d&e=%C3%BC");
        let mp = multipart(&[("f".into(), MultipartValue::Text("v".into())), ("up".into(), MultipartValue::File { name: "x.bin".into(), bytes: Arc::new(vec![1, 2]) })], "B");
        let s = String::from_utf8_lossy(&mp);
        assert!(s.starts_with("--B\r\nContent-Disposition: form-data; name=\"f\"\r\n\r\nv\r\n--B\r\n"));
        assert!(s.contains("filename=\"x.bin\""));
        assert!(s.ends_with("--B--\r\n"));
        assert_eq!(graphql_body("{ me { id } }", r#"{"a":1}"#).unwrap(), r#"{"query":"{ me { id } }","variables":{"a":1}}"#);
        assert!(graphql_body("q", "{").is_err());
        assert_eq!(body_text(b"hello", 3), ("hel".into(), true, false));
        assert!(body_text(&[0xff, 0xfe, 0, 1, 2, 3, 4, 5], 64).2);
        let gz = gzip(b"aaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(&gz[..2], &[0x1f, 0x8b]);
    }

    #[test]
    fn cert_patterns() {
        assert!(host_matches("", "a.b"));
        assert!(host_matches("*.corp.test", "api.corp.test"));
        assert!(!host_matches("*.corp.test", "corp.test"));
        assert!(host_matches("API.corp.test", "api.corp.test"));
        assert!(load_identity(b"nope", None).unwrap_err().contains("PKCS#12"));
        assert!(load_identity(b"-----BEGIN CERTIFICATE-----\n", Some(b"-----BEGIN ENCRYPTED PRIVATE KEY-----")).unwrap_err().contains("encrypted"));
    }
}
