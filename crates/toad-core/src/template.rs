//! `{{templates}}`: variables and generators inside URLs, headers, bodies, cookies and values.
//!
//! - `{{name}}` reads a variable: environment, data column (`{{users.email}}`), extracted
//!   value, pre-request value, or a built-in (`vu.id`, `iteration`, `scenario`, `run.id`).
//! - `{{$generator}}` / `{{$generator(arg, …)}}` makes a value per occurrence. Arguments may
//!   contain templates: `{{$base64({{user}}:{{pass}})}}`.
//! - `\{{` is a literal `{{`.
//!
//! Templates are parsed once per run; rendering a template with no placeholders is a copy.

use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};

pub use fastrand::Rng;

#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Lit(String),
    Var(String),
    Gen(Gen, Vec<Template>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gen {
    Uuid,
    RandomInt,
    RandomFloat,
    RandomString,
    Pick,
    Seq,
    Email,
    Name,
    FirstName,
    LastName,
    Word,
    Timestamp,
    TimestampSec,
    IsoDate,
    Base64,
    UrlEncode,
    Lower,
    Upper,
}

/// Generator names as written after `$`, with the argument count they accept.
pub const GENERATORS: &[(&str, Gen, usize, usize, &str)] = &[
    ("uuid", Gen::Uuid, 0, 0, "Random UUID v4"),
    ("randomInt", Gen::RandomInt, 2, 2, "Integer from min to max, inclusive"),
    ("randomFloat", Gen::RandomFloat, 2, 3, "Decimal from min to max (optional decimals, default 2)"),
    ("randomString", Gen::RandomString, 1, 1, "Letters and digits of the given length"),
    ("pick", Gen::Pick, 1, 64, "One of the arguments at random"),
    ("seq", Gen::Seq, 0, 0, "1, 2, 3… shared by every virtual user"),
    ("email", Gen::Email, 0, 0, "Random email at example.com"),
    ("name", Gen::Name, 0, 0, "Random first and last name"),
    ("firstName", Gen::FirstName, 0, 0, "Random first name"),
    ("lastName", Gen::LastName, 0, 0, "Random last name"),
    ("word", Gen::Word, 0, 0, "Random lowercase word"),
    ("timestamp", Gen::Timestamp, 0, 0, "Epoch milliseconds at send time"),
    ("timestampSec", Gen::TimestampSec, 0, 0, "Epoch seconds at send time"),
    ("isoDate", Gen::IsoDate, 0, 0, "UTC date-time at send time, ISO 8601"),
    ("base64", Gen::Base64, 1, 1, "Base64 of the argument"),
    ("urlencode", Gen::UrlEncode, 1, 1, "Percent-encode the argument"),
    ("lower", Gen::Lower, 1, 1, "Lowercase the argument"),
    ("upper", Gen::Upper, 1, 1, "Uppercase the argument"),
];

/// Built-in variables every step can read.
pub const BUILTINS: &[&str] = &["vu.id", "iteration", "scenario", "run.id"];

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Template {
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ParseError {
    #[error("`{{{{` at {0} is never closed with `}}}}`")]
    Unclosed(usize),
    #[error("empty `{{{{}}}}`")]
    Empty,
    #[error("unknown generator `${0}`")]
    UnknownGen(String),
    #[error("`${name}` takes {expected} argument(s), got {got}")]
    Arity { name: String, expected: String, got: usize },
    #[error("variable name `{0}` has characters other than letters, digits, `_`, `-` and `.`")]
    BadName(String),
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum RenderError {
    #[error("`{0}` has no value here")]
    Missing(String),
    #[error("{0}")]
    Bad(String),
}

fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// Find the `}}` that closes a `{{` whose content starts at `from`, honouring nesting.
fn find_close(s: &str, from: usize) -> Option<usize> {
    let b = s.as_bytes();
    let mut depth = 0usize;
    let mut i = from;
    while i + 1 < b.len() {
        if b[i] == b'\\' && b[i + 1] == b'{' {
            i += 2;
            continue;
        }
        if b[i] == b'{' && b[i + 1] == b'{' {
            depth += 1;
            i += 2;
        } else if b[i] == b'}' && b[i + 1] == b'}' {
            if depth == 0 {
                return Some(i);
            }
            depth -= 1;
            i += 2;
        } else {
            i += 1;
        }
    }
    None
}

/// Split generator arguments on top-level commas (commas inside `{{…}}` don't split).
fn split_args(s: &str) -> Vec<&str> {
    if s.trim().is_empty() {
        return vec![];
    }
    let b = s.as_bytes();
    let (mut depth, mut start, mut out) = (0usize, 0usize, Vec::new());
    let mut i = 0;
    while i < b.len() {
        if i + 1 < b.len() && b[i] == b'{' && b[i + 1] == b'{' {
            depth += 1;
            i += 2;
            continue;
        }
        if i + 1 < b.len() && b[i] == b'}' && b[i + 1] == b'}' {
            depth = depth.saturating_sub(1);
            i += 2;
            continue;
        }
        if b[i] == b',' && depth == 0 {
            out.push(&s[start..i]);
            start = i + 1;
        }
        i += 1;
    }
    out.push(&s[start..]);
    out
}

impl Template {
    pub fn literal(s: impl Into<String>) -> Template {
        Template { parts: vec![Part::Lit(s.into())] }
    }

    pub fn parse(s: &str) -> Result<Template, ParseError> {
        let mut parts = Vec::new();
        let mut lit = String::new();
        let mut i = 0;
        let b = s.as_bytes();
        while i < s.len() {
            if b[i] == b'\\' && s[i + 1..].starts_with("{{") {
                lit.push_str("{{");
                i += 3;
                continue;
            }
            if s[i..].starts_with("{{") {
                let close = find_close(s, i + 2).ok_or(ParseError::Unclosed(i))?;
                let inner = s[i + 2..close].trim();
                if !lit.is_empty() {
                    parts.push(Part::Lit(std::mem::take(&mut lit)));
                }
                parts.push(Self::parse_placeholder(inner)?);
                i = close + 2;
                continue;
            }
            let ch = s[i..].chars().next().expect("in bounds");
            lit.push(ch);
            i += ch.len_utf8();
        }
        if !lit.is_empty() {
            parts.push(Part::Lit(lit));
        }
        Ok(Template { parts })
    }

    fn parse_placeholder(inner: &str) -> Result<Part, ParseError> {
        if inner.is_empty() {
            return Err(ParseError::Empty);
        }
        let Some(rest) = inner.strip_prefix('$') else {
            if !valid_name(inner) {
                return Err(ParseError::BadName(inner.to_string()));
            }
            return Ok(Part::Var(inner.to_string()));
        };
        let (name, args) = match rest.find('(') {
            Some(p) if rest.ends_with(')') => (&rest[..p], split_args(&rest[p + 1..rest.len() - 1])),
            _ => (rest, vec![]),
        };
        let name = name.trim();
        let &(_, gen, min, max, _) =
            GENERATORS.iter().find(|g| g.0 == name).ok_or_else(|| ParseError::UnknownGen(name.to_string()))?;
        if args.len() < min || args.len() > max {
            let expected = if min == max { min.to_string() } else { format!("{min}–{max}") };
            return Err(ParseError::Arity { name: name.into(), expected, got: args.len() });
        }
        let args = args.iter().map(|a| Template::parse(a.trim())).collect::<Result<Vec<_>, _>>()?;
        Ok(Part::Gen(gen, args))
    }

    pub fn is_static(&self) -> bool {
        self.parts.iter().all(|p| matches!(p, Part::Lit(_)))
    }

    /// The text of a template with no placeholders.
    pub fn as_literal(&self) -> Option<String> {
        self.is_static().then(|| {
            self.parts
                .iter()
                .map(|p| match p {
                    Part::Lit(s) => s.as_str(),
                    _ => "",
                })
                .collect()
        })
    }

    /// Variable names referenced, including inside generator arguments.
    pub fn vars(&self) -> Vec<String> {
        let mut out = Vec::new();
        self.collect_vars(&mut out);
        out
    }

    fn collect_vars(&self, out: &mut Vec<String>) {
        for p in &self.parts {
            match p {
                Part::Var(v) if !out.contains(v) => out.push(v.clone()),
                Part::Gen(_, args) => args.iter().for_each(|a| a.collect_vars(out)),
                _ => {}
            }
        }
    }

    pub fn render(&self, ctx: &mut Ctx<'_>) -> Result<String, RenderError> {
        if let [Part::Lit(s)] = self.parts.as_slice() {
            return Ok(s.clone());
        }
        let mut out = String::new();
        for p in &self.parts {
            match p {
                Part::Lit(s) => out.push_str(s),
                Part::Var(v) => out.push_str(&ctx.scope.lookup(v).ok_or_else(|| RenderError::Missing(v.clone()))?),
                Part::Gen(g, args) => {
                    let args = args.iter().map(|a| a.render(ctx)).collect::<Result<Vec<_>, _>>()?;
                    generate(*g, &args, ctx, &mut out)?;
                }
            }
        }
        Ok(out)
    }

    /// Render with every placeholder replaced by `0` (for validating a body's syntax).
    pub fn placeholder_text(&self) -> String {
        self.parts
            .iter()
            .map(|p| match p {
                Part::Lit(s) => s.clone(),
                _ => "0".to_string(),
            })
            .collect()
    }
}

/// Where variables come from while rendering.
pub trait Scope {
    fn lookup(&self, name: &str) -> Option<String>;
}

impl Scope for std::collections::HashMap<String, String> {
    fn lookup(&self, name: &str) -> Option<String> {
        self.get(name).cloned()
    }
}

pub struct Ctx<'a> {
    pub scope: &'a dyn Scope,
    pub rng: &'a mut fastrand::Rng,
    pub seq: &'a AtomicU64,
}

const FIRST: &[&str] = &["Ada", "Alan", "Grace", "Linus", "Margaret", "Ken", "Barbara", "Dennis", "Frances", "Edsger", "Radia", "Tim", "Hedy", "Donald", "Katherine", "John"];
const LAST: &[&str] = &["Lovelace", "Turing", "Hopper", "Torvalds", "Hamilton", "Thompson", "Liskov", "Ritchie", "Allen", "Dijkstra", "Perlman", "Berners-Lee", "Lamarr", "Knuth", "Johnson", "McCarthy"];
const WORDS: &[&str] = &["toad", "lily", "pond", "reed", "moss", "fern", "stone", "river", "cloud", "ember", "maple", "cedar", "quartz", "harbor", "signal", "meadow", "copper", "lantern", "orbit", "pixel"];

fn num_arg(args: &[String], i: usize, gen: &str) -> Result<f64, RenderError> {
    args[i].trim().parse::<f64>().map_err(|_| RenderError::Bad(format!("`${gen}` argument {} isn't a number: {:?}", i + 1, args[i])))
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// `2026-11-06T12:34:56.789Z` for epoch milliseconds (proleptic Gregorian, UTC).
pub fn iso_date(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z", sod / 3600, (sod / 60) % 60, sod % 60)
}

pub fn uuid_v4(rng: &mut fastrand::Rng) -> String {
    let mut b: [u8; 16] = rng.u128(..).to_le_bytes();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn generate(g: Gen, args: &[String], ctx: &mut Ctx<'_>, out: &mut String) -> Result<(), RenderError> {
    let rng = &mut *ctx.rng;
    match g {
        Gen::Uuid => out.push_str(&uuid_v4(rng)),
        Gen::RandomInt => {
            let (a, b) = (num_arg(args, 0, "randomInt")? as i64, num_arg(args, 1, "randomInt")? as i64);
            let (lo, hi) = (a.min(b), a.max(b));
            let _ = write!(out, "{}", rng.i64(lo..=hi));
        }
        Gen::RandomFloat => {
            let (a, b) = (num_arg(args, 0, "randomFloat")?, num_arg(args, 1, "randomFloat")?);
            let decimals = if args.len() > 2 { num_arg(args, 2, "randomFloat")?.clamp(0.0, 12.0) as usize } else { 2 };
            let v = a.min(b) + rng.f64() * (a - b).abs();
            let _ = write!(out, "{v:.decimals$}");
        }
        Gen::RandomString => {
            let n = num_arg(args, 0, "randomString")?.clamp(0.0, 4096.0) as usize;
            const ALNUM: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            out.extend((0..n).map(|_| ALNUM[rng.usize(..ALNUM.len())] as char));
        }
        Gen::Pick => out.push_str(&args[rng.usize(..args.len())]),
        Gen::Seq => {
            let _ = write!(out, "{}", ctx.seq.fetch_add(1, Ordering::Relaxed) + 1);
        }
        Gen::Email => {
            let _ = write!(out, "{}.{}{}@example.com", FIRST[rng.usize(..FIRST.len())].to_lowercase(), LAST[rng.usize(..LAST.len())].to_lowercase().replace('-', ""), rng.u32(1..10_000));
        }
        Gen::Name => {
            let _ = write!(out, "{} {}", FIRST[rng.usize(..FIRST.len())], LAST[rng.usize(..LAST.len())]);
        }
        Gen::FirstName => out.push_str(FIRST[rng.usize(..FIRST.len())]),
        Gen::LastName => out.push_str(LAST[rng.usize(..LAST.len())]),
        Gen::Word => out.push_str(WORDS[rng.usize(..WORDS.len())]),
        Gen::Timestamp => {
            let _ = write!(out, "{}", now_ms());
        }
        Gen::TimestampSec => {
            let _ = write!(out, "{}", now_ms() / 1000);
        }
        Gen::IsoDate => out.push_str(&iso_date(now_ms())),
        Gen::Base64 => out.push_str(&base64::Engine::encode(&base64::engine::general_purpose::STANDARD, args[0].as_bytes())),
        Gen::UrlEncode => out.push_str(&percent_encoding::utf8_percent_encode(&args[0], percent_encoding::NON_ALPHANUMERIC).to_string()),
        Gen::Lower => out.push_str(&args[0].to_lowercase()),
        Gen::Upper => out.push_str(&args[0].to_uppercase()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn render(t: &str, vars: &[(&str, &str)]) -> Result<String, RenderError> {
        let scope: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let mut rng = fastrand::Rng::with_seed(7);
        let seq = AtomicU64::new(0);
        Template::parse(t).unwrap().render(&mut Ctx { scope: &scope, rng: &mut rng, seq: &seq })
    }

    #[test]
    fn variables_and_literals() {
        assert_eq!(render("plain", &[]).unwrap(), "plain");
        assert_eq!(render("{{baseUrl}}/users/{{ id }}", &[("baseUrl", "http://x"), ("id", "7")]).unwrap(), "http://x/users/7");
        assert_eq!(render("{{users.email}}", &[("users.email", "a@b")]).unwrap(), "a@b");
        assert_eq!(render("\\{{literal}}", &[]).unwrap(), "{{literal}}");
        assert_eq!(render("{{token}}", &[]), Err(RenderError::Missing("token".into())));
    }

    #[test]
    fn generators() {
        let u = render("{{$uuid}}", &[]).unwrap();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
        let n: i64 = render("{{$randomInt(5, 9)}}", &[]).unwrap().parse().unwrap();
        assert!((5..=9).contains(&n));
        assert_eq!(render("{{$seq}}-{{$seq}}", &[]).unwrap(), "1-2");
        assert_eq!(render("{{$base64({{u}}:{{p}})}}", &[("u", "ada"), ("p", "pw")]).unwrap(), "YWRhOnB3");
        assert_eq!(render("{{$urlencode(a b/c)}}", &[]).unwrap(), "a%20b%2Fc");
        assert_eq!(render("{{$upper({{x}})}}", &[("x", "hi")]).unwrap(), "HI");
        assert!(["a", "b"].contains(&render("{{$pick(a, b)}}", &[]).unwrap().as_str()));
        assert_eq!(render("{{$randomString(12)}}", &[]).unwrap().len(), 12);
        assert!(render("{{$randomFloat(1, 2, 3)}}", &[]).unwrap().split('.').nth(1).unwrap().len() == 3);
    }

    #[test]
    fn parse_errors_and_vars() {
        assert!(matches!(Template::parse("{{a"), Err(ParseError::Unclosed(0))));
        assert!(matches!(Template::parse("{{$nope}}"), Err(ParseError::UnknownGen(_))));
        assert!(matches!(Template::parse("{{$randomInt(1)}}"), Err(ParseError::Arity { .. })));
        assert!(matches!(Template::parse("{{a b}}"), Err(ParseError::BadName(_))));
        let t = Template::parse("{{a}}/{{$base64({{b}}:{{a}})}}").unwrap();
        assert_eq!(t.vars(), vec!["a".to_string(), "b".to_string()]);
        assert!(!t.is_static());
        assert_eq!(Template::parse("{\"n\": {{$seq}}}").unwrap().placeholder_text(), "{\"n\": 0}");
        assert_eq!(Template::parse("x").unwrap().as_literal().as_deref(), Some("x"));
    }

    #[test]
    fn iso_dates() {
        assert_eq!(iso_date(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_date(1_788_696_896_789), "2026-09-06T12:14:56.789Z");
        assert_eq!(iso_date(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
