//! Target classification. The check runs *after* DNS resolution, and the engine pins
//! the resolved addresses so the run hits exactly what was checked (no rebinding).

use std::net::{IpAddr, SocketAddr};

#[derive(Debug, thiserror::Error)]
pub enum SafetyError {
    #[error("invalid URL: {0}")]
    Url(String),
    #[error("could not resolve {host}: {message}")]
    Dns { host: String, message: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedTarget {
    /// Lowercased host as it appears in the URL (without brackets for IPv6).
    pub host: String,
    pub addrs: Vec<SocketAddr>,
}

impl ResolvedTarget {
    pub fn is_loopback(&self) -> bool {
        !self.addrs.is_empty() && self.addrs.iter().all(|a| is_loopback(a.ip()))
    }

    /// Every address is loopback or private (RFC 1918, ULA, link-local).
    pub fn is_private(&self) -> bool {
        !self.addrs.is_empty() && self.addrs.iter().all(|a| is_loopback(a.ip()) || is_private(a.ip()))
    }
}

pub fn is_loopback(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback(),
    }
}

pub fn is_private(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            let seg0 = v6.segments()[0];
            (seg0 & 0xfe00) == 0xfc00 || (seg0 & 0xffc0) == 0xfe80
        }
    }
}

/// Host part of a URL, normalized for comparisons and the per-session approval set.
pub fn url_host(url: &str) -> Result<(String, u16), SafetyError> {
    let u = reqwest::Url::parse(url.trim()).map_err(|e| SafetyError::Url(e.to_string()))?;
    let host = match u.host() {
        Some(url::Host::Ipv6(v6)) => v6.to_string(),
        Some(h) => h.to_string().to_ascii_lowercase(),
        None => return Err(SafetyError::Url("URL has no host".into())),
    };
    let port = u.port_or_known_default().unwrap_or(80);
    Ok((host, port))
}

pub async fn resolve(url: &str) -> Result<ResolvedTarget, SafetyError> {
    let (host, port) = url_host(url)?;
    let addrs: Vec<SocketAddr> = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|e| SafetyError::Dns { host: host.clone(), message: e.to_string() })?
            .collect()
    };
    if addrs.is_empty() {
        return Err(SafetyError::Dns { host, message: "no addresses".into() });
    }
    Ok(ResolvedTarget { host, addrs })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification() {
        for ip in ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"] {
            assert!(is_loopback(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["10.0.0.1", "192.168.1.1", "172.16.0.1", "fd00::1", "fe80::1"] {
            let ip: IpAddr = ip.parse().unwrap();
            assert!(!is_loopback(ip) && is_private(ip), "{ip}");
        }
        for ip in ["8.8.8.8", "2001:4860::8888", "172.32.0.1"] {
            let ip: IpAddr = ip.parse().unwrap();
            assert!(!is_loopback(ip) && !is_private(ip), "{ip}");
        }
    }

    #[test]
    fn hosts() {
        assert_eq!(url_host("http://LocalHost:8080/x").unwrap(), ("localhost".into(), 8080));
        assert_eq!(url_host("https://[::1]/").unwrap(), ("::1".into(), 443));
        assert!(url_host("nope").is_err());
    }

    #[tokio::test]
    async fn resolves_localhost_to_loopback() {
        let t = resolve("http://localhost:1/").await.unwrap();
        assert!(t.is_loopback(), "{t:?}");
        let t = resolve("http://127.0.0.1:1/").await.unwrap();
        assert!(t.is_loopback());
        let t = resolve("http://10.1.2.3/").await.unwrap();
        assert!(!t.is_loopback() && t.is_private());
    }
}
