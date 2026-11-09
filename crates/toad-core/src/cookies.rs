//! A cookie jar (RFC 6265 essentials): domain and path matching, Secure, Max-Age/Expires.
//! Each virtual user gets its own jar by default; tests can share one or turn cookies off.

use crate::spec::SeedCookie;

#[derive(Debug, Clone, PartialEq)]
pub struct Cookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub host_only: bool,
    pub path: String,
    pub secure: bool,
    pub expires_ms: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct Jar {
    cookies: Vec<Cookie>,
}

fn default_path(path: &str) -> String {
    match path.rfind('/') {
        Some(0) | None => "/".into(),
        Some(i) => path[..i].to_string(),
    }
}

fn path_matches(req: &str, cookie: &str) -> bool {
    req == cookie || (req.starts_with(cookie) && (cookie.ends_with('/') || req[cookie.len()..].starts_with('/')))
}

fn domain_matches(host: &str, c: &Cookie) -> bool {
    host == c.domain || (!c.host_only && host.ends_with(&format!(".{}", c.domain)))
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// Parse an HTTP date ("Wed, 21 Oct 2026 07:28:00 GMT", also "21-Oct-2026") to epoch ms.
pub fn parse_http_date(s: &str) -> Option<i64> {
    let s = s.split_once(',').map_or(s, |(_, r)| r).trim();
    let parts: Vec<&str> = s.split([' ', '-']).filter(|p| !p.is_empty()).collect();
    if parts.len() < 4 {
        return None;
    }
    let day: i64 = parts[0].parse().ok()?;
    let month = MONTHS.iter().position(|m| parts[1].to_ascii_lowercase().starts_with(m))? as i64 + 1;
    let mut year: i64 = parts[2].parse().ok()?;
    if year < 100 {
        year += if year < 70 { 2000 } else { 1900 };
    }
    let hms: Vec<i64> = parts[3].split(':').filter_map(|x| x.parse().ok()).collect();
    if hms.len() != 3 {
        return None;
    }
    // days_from_civil
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400) + hms[0] * 3600 + hms[1] * 60 + hms[2]) * 1000)
}

impl Jar {
    pub fn clear(&mut self) {
        self.cookies.clear();
    }

    pub fn len(&self) -> usize {
        self.cookies.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cookies.is_empty()
    }

    pub fn seed(&mut self, s: &SeedCookie) {
        let domain = s.domain.trim().trim_start_matches('.').to_ascii_lowercase();
        let path = if s.path.trim().is_empty() { "/".to_string() } else { s.path.trim().to_string() };
        self.upsert(Cookie { name: s.name.clone(), value: s.value.clone(), domain, host_only: false, path, secure: s.secure, expires_ms: None });
    }

    fn upsert(&mut self, c: Cookie) {
        self.cookies.retain(|o| !(o.name == c.name && o.domain == c.domain && o.path == c.path));
        self.cookies.push(c);
    }

    /// Store a `Set-Cookie` header received from `url`.
    pub fn store(&mut self, url: &url::Url, header: &str, now_ms: i64) {
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        let mut parts = header.split(';');
        let Some((name, value)) = parts.next().and_then(|p| p.split_once('=')) else { return };
        let mut c = Cookie {
            name: name.trim().to_string(),
            value: value.trim().trim_matches('"').to_string(),
            domain: host.clone(),
            host_only: true,
            path: default_path(url.path()),
            secure: false,
            expires_ms: None,
        };
        if c.name.is_empty() {
            return;
        }
        let mut max_age: Option<i64> = None;
        for attr in parts {
            let (k, v) = attr.split_once('=').map_or((attr.trim(), ""), |(k, v)| (k.trim(), v.trim()));
            match k.to_ascii_lowercase().as_str() {
                "domain" if !v.is_empty() => {
                    let d = v.trim_start_matches('.').to_ascii_lowercase();
                    // A server may only set cookies for its own domain or a parent of it.
                    if host == d || host.ends_with(&format!(".{d}")) {
                        c.domain = d;
                        c.host_only = false;
                    } else {
                        return;
                    }
                }
                "path" if v.starts_with('/') => c.path = v.to_string(),
                "secure" => c.secure = true,
                "max-age" => max_age = v.parse().ok(),
                "expires" => c.expires_ms = c.expires_ms.or_else(|| parse_http_date(v)),
                _ => {}
            }
        }
        if let Some(ma) = max_age {
            c.expires_ms = Some(now_ms + ma * 1000);
        }
        if c.expires_ms.is_some_and(|e| e <= now_ms) {
            self.cookies.retain(|o| !(o.name == c.name && o.domain == c.domain && o.path == c.path));
            return;
        }
        self.upsert(c);
    }

    /// The `Cookie` header value for a request to `url`, or `None` when no cookie applies.
    pub fn header_for(&mut self, url: &url::Url, now_ms: i64) -> Option<String> {
        self.cookies.retain(|c| c.expires_ms.is_none_or(|e| e > now_ms));
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        let secure = url.scheme() == "https";
        let mut matching: Vec<&Cookie> = self
            .cookies
            .iter()
            .filter(|c| domain_matches(&host, c) && path_matches(url.path(), &c.path) && (!c.secure || secure))
            .collect();
        if matching.is_empty() {
            return None;
        }
        // Longer paths first (RFC 6265 §5.4).
        matching.sort_by_key(|c| std::cmp::Reverse(c.path.len()));
        Some(matching.iter().map(|c| format!("{}={}", c.name, c.value)).collect::<Vec<_>>().join("; "))
    }

    pub fn cookies(&self) -> &[Cookie] {
        &self.cookies
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> url::Url {
        url::Url::parse(s).unwrap()
    }

    #[test]
    fn scoping() {
        let mut j = Jar::default();
        let now = 1_000_000;
        j.store(&u("https://api.shop.test/auth/login"), "sid=abc; Path=/; HttpOnly; Secure", now);
        j.store(&u("https://api.shop.test/auth/login"), "pref=dark; Domain=shop.test; Path=/", now);
        j.store(&u("https://api.shop.test/auth/login"), "evil=1; Domain=other.test", now);
        j.store(&u("https://api.shop.test/auth/login"), "scoped=1", now);
        assert_eq!(j.len(), 3);
        assert_eq!(j.header_for(&u("https://api.shop.test/orders"), now).as_deref(), Some("sid=abc; pref=dark"));
        assert_eq!(j.header_for(&u("https://api.shop.test/auth/x"), now).unwrap(), "scoped=1; sid=abc; pref=dark");
        // Secure cookies don't go over http; host-only cookies don't go to other subdomains.
        assert_eq!(j.header_for(&u("http://www.shop.test/"), now).as_deref(), Some("pref=dark"));
        assert_eq!(j.header_for(&u("https://elsewhere.test/"), now), None);
    }

    #[test]
    fn expiry_and_replacement() {
        let mut j = Jar::default();
        let url = u("http://localhost:8080/");
        j.store(&url, "a=1; Max-Age=10", 0);
        j.store(&url, "a=2; Max-Age=10", 0);
        assert_eq!(j.header_for(&url, 5_000).as_deref(), Some("a=2"));
        assert_eq!(j.header_for(&url, 11_000), None);
        j.store(&url, "b=1", 0);
        j.store(&url, "b=; Max-Age=0", 0);
        assert!(j.is_empty());
        j.store(&url, "c=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT", 0);
        assert_eq!(j.header_for(&url, 0).as_deref(), Some("c=1"));
        assert_eq!(j.header_for(&url, 1_445_412_480_001), None);
        assert_eq!(parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT"), Some(1_445_412_480_000));
    }

    #[test]
    fn seeds() {
        let mut j = Jar::default();
        j.seed(&SeedCookie { domain: ".shop.test".into(), path: String::new(), name: "ab".into(), value: "b".into(), secure: false });
        assert_eq!(j.header_for(&u("http://api.shop.test/x"), 0).as_deref(), Some("ab=b"));
    }
}
