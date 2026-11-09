//! Reading responses: extractors, checks and Run if rules.
//!
//! JSONPath supports the common subset: `$`, `.key`, `['key']`, `[n]` (negative from the end),
//! `[*]`, `.*` and `..key`. A path without `$` is read from the root (`data.token`).
//! XPath supports `/a/b`, `//b`, `*`, `[n]`, `[@attr='v']`, `@attr` and `text()`; element
//! names match their local name, so namespaces don't get in the way.

use crate::spec::*;
use serde_json::Value;
use std::cell::OnceCell;

// ---------- JSONPath ----------

#[derive(Debug, Clone, PartialEq)]
pub enum JSeg {
    Key(String),
    Index(i64),
    Wild,
    Descend(String),
}

pub fn parse_jsonpath(expr: &str) -> Result<Vec<JSeg>, String> {
    let s = expr.trim();
    let s = s.strip_prefix('$').unwrap_or(s);
    let b = s.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    let ident_end = |from: usize| {
        let mut j = from;
        while j < b.len() && b[j] != b'.' && b[j] != b'[' {
            j += 1;
        }
        j
    };
    // A leading key without a dot (`data.token`).
    if i < b.len() && b[i] != b'.' && b[i] != b'[' {
        let j = ident_end(i);
        out.push(JSeg::Key(s[i..j].to_string()));
        i = j;
    }
    while i < b.len() {
        match b[i] {
            b'.' if b.get(i + 1) == Some(&b'.') => {
                let j = ident_end(i + 2);
                if j == i + 2 {
                    return Err("`..` must be followed by a key".into());
                }
                out.push(JSeg::Descend(s[i + 2..j].to_string()));
                i = j;
            }
            b'.' => {
                let j = ident_end(i + 1);
                let key = &s[i + 1..j];
                if key.is_empty() {
                    return Err(format!("empty key at {}", i + 1));
                }
                out.push(if key == "*" { JSeg::Wild } else { JSeg::Key(key.to_string()) });
                i = j;
            }
            b'[' => {
                let close = s[i..].find(']').map(|p| p + i).ok_or("`[` is never closed")?;
                let inner = s[i + 1..close].trim();
                if inner == "*" {
                    out.push(JSeg::Wild);
                } else if (inner.starts_with('\'') && inner.ends_with('\'') || inner.starts_with('"') && inner.ends_with('"')) && inner.len() >= 2 {
                    out.push(JSeg::Key(inner[1..inner.len() - 1].to_string()));
                } else {
                    let n: i64 = inner.parse().map_err(|_| format!("`[{inner}]` isn't an index, `*` or a quoted key"))?;
                    out.push(JSeg::Index(n));
                }
                i = close + 1;
            }
            c => return Err(format!("unexpected `{}` at {i}", c as char)),
        }
    }
    Ok(out)
}

fn descend<'a>(v: &'a Value, key: &str, out: &mut Vec<&'a Value>) {
    match v {
        Value::Object(m) => {
            if let Some(x) = m.get(key) {
                out.push(x);
            }
            for x in m.values() {
                descend(x, key, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| descend(x, key, out)),
        _ => {}
    }
}

pub fn eval_jsonpath<'a>(root: &'a Value, path: &[JSeg]) -> Vec<&'a Value> {
    let mut cur = vec![root];
    for seg in path {
        let mut next = Vec::new();
        for v in cur {
            match seg {
                JSeg::Key(k) => {
                    if let Some(x) = v.get(k.as_str()) {
                        next.push(x);
                    }
                }
                JSeg::Index(n) => {
                    if let Value::Array(a) = v {
                        let idx = if *n < 0 { a.len() as i64 + n } else { *n };
                        if let Some(x) = usize::try_from(idx).ok().and_then(|i| a.get(i)) {
                            next.push(x);
                        }
                    }
                }
                JSeg::Wild => match v {
                    Value::Array(a) => next.extend(a.iter()),
                    Value::Object(m) => next.extend(m.values()),
                    _ => {}
                },
                JSeg::Descend(k) => descend(v, k, &mut next),
            }
        }
        cur = next;
    }
    cur
}

pub fn json_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

// ---------- XPath ----------

#[derive(Debug, Clone, PartialEq)]
pub enum XTest {
    Name(String),
    Any,
    Attr(String),
    Text,
}

#[derive(Debug, Clone, PartialEq)]
pub enum XPred {
    Index(usize),
    AttrEq(String, String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct XStep {
    pub descendant: bool,
    pub test: XTest,
    pub preds: Vec<XPred>,
}

pub fn parse_xpath(expr: &str) -> Result<Vec<XStep>, String> {
    let s = expr.trim();
    if s.is_empty() {
        return Err("empty XPath".into());
    }
    let mut steps = Vec::new();
    let mut i = 0;
    let b = s.as_bytes();
    // A relative path is read from anywhere in the document.
    let mut descendant = !s.starts_with('/');
    while i < b.len() {
        if s[i..].starts_with("//") {
            descendant = true;
            i += 2;
        } else if b[i] == b'/' {
            i += 1;
        }
        let start = i;
        let mut depth = 0;
        while i < b.len() && (depth > 0 || b[i] != b'/') {
            match b[i] {
                b'[' => depth += 1,
                b']' => depth -= 1,
                _ => {}
            }
            i += 1;
        }
        let raw = &s[start..i];
        if raw.is_empty() {
            return Err("empty step".into());
        }
        let (head, mut rest) = match raw.find('[') {
            Some(p) => (&raw[..p], &raw[p..]),
            None => (raw, ""),
        };
        let test = match head {
            "*" => XTest::Any,
            "text()" => XTest::Text,
            h if h.starts_with('@') => XTest::Attr(h[1..].to_string()),
            h => XTest::Name(h.rsplit(':').next().unwrap_or(h).to_string()),
        };
        let mut preds = Vec::new();
        while let Some(r) = rest.strip_prefix('[') {
            let close = r.find(']').ok_or("`[` is never closed")?;
            let p = r[..close].trim();
            if let Some(attr) = p.strip_prefix('@') {
                let (name, val) = attr.split_once('=').ok_or("predicate must be [n] or [@attr='value']")?;
                let val = val.trim().trim_matches(|c| c == '\'' || c == '"');
                preds.push(XPred::AttrEq(name.trim().to_string(), val.to_string()));
            } else {
                let n: usize = p.parse().map_err(|_| format!("`[{p}]` isn't a position or [@attr='value']"))?;
                if n == 0 {
                    return Err("XPath positions start at 1".into());
                }
                preds.push(XPred::Index(n));
            }
            rest = &r[close + 1..];
        }
        steps.push(XStep { descendant, test, preds });
        descendant = false;
    }
    Ok(steps)
}

fn elem_text(n: roxmltree::Node<'_, '_>) -> String {
    n.descendants().filter(|d| d.is_text()).filter_map(|d| d.text()).collect::<String>()
}

pub fn eval_xpath(doc: &roxmltree::Document<'_>, steps: &[XStep]) -> Vec<String> {
    #[derive(Clone, Copy)]
    enum Item<'a, 'i> {
        Node(roxmltree::Node<'a, 'i>),
        Text(&'a str),
    }
    let mut cur: Vec<Item> = vec![Item::Node(doc.root())];
    for step in steps {
        let mut next = Vec::new();
        for item in &cur {
            let Item::Node(n) = *item else { continue };
            let candidates: Vec<roxmltree::Node> =
                if step.descendant { n.descendants().filter(|d| d.id() != n.id()).collect() } else { n.children().collect() };
            match &step.test {
                XTest::Attr(a) => {
                    let base = if step.descendant { n.descendants().collect::<Vec<_>>() } else { vec![n] };
                    for e in base.into_iter().filter(|e| e.is_element()) {
                        if let Some(v) = e.attributes().find(|x| x.name() == a.as_str()) {
                            next.push(Item::Text(v.value()));
                        }
                    }
                }
                XTest::Text => {
                    for c in candidates.into_iter().filter(|c| c.is_text()) {
                        if let Some(t) = c.text() {
                            next.push(Item::Text(t));
                        }
                    }
                }
                test => {
                    let mut matched: Vec<roxmltree::Node> = candidates
                        .into_iter()
                        .filter(|c| c.is_element() && matches!(test, XTest::Any | XTest::Name(_)))
                        .filter(|c| match test {
                            XTest::Name(name) => c.tag_name().name() == name,
                            _ => true,
                        })
                        .collect();
                    for p in &step.preds {
                        matched = match p {
                            XPred::Index(i) => matched.get(i - 1).copied().into_iter().collect(),
                            XPred::AttrEq(a, v) => matched.into_iter().filter(|c| c.attribute(a.as_str()) == Some(v.as_str())).collect(),
                        };
                    }
                    next.extend(matched.into_iter().map(Item::Node));
                }
            }
        }
        cur = next;
    }
    cur.into_iter()
        .map(|i| match i {
            Item::Node(n) => elem_text(n),
            Item::Text(t) => t.to_string(),
        })
        .collect()
}

// ---------- the response being read ----------

pub struct Resp<'a> {
    pub status: u16,
    pub headers: &'a [(String, String)],
    pub body: &'a [u8],
    pub latency_ms: f64,
    json: OnceCell<Option<Value>>,
}

impl<'a> Resp<'a> {
    pub fn new(status: u16, headers: &'a [(String, String)], body: &'a [u8], latency_ms: f64) -> Self {
        Resp { status, headers, body, latency_ms, json: OnceCell::new() }
    }

    pub fn json(&self) -> Option<&Value> {
        self.json.get_or_init(|| serde_json::from_slice(self.body).ok()).as_ref()
    }

    pub fn header_values(&self, name: &str) -> Vec<String> {
        self.headers.iter().filter(|(n, _)| n.eq_ignore_ascii_case(name.trim())).map(|(_, v)| v.clone()).collect()
    }

    pub fn set_cookies(&self, name: &str) -> Vec<String> {
        self.header_values("set-cookie")
            .iter()
            .filter_map(|sc| {
                let first = sc.split(';').next()?;
                let (n, v) = first.split_once('=')?;
                (n.trim() == name.trim()).then(|| v.trim().to_string())
            })
            .collect()
    }

    fn text(&self) -> std::borrow::Cow<'_, str> {
        String::from_utf8_lossy(self.body)
    }
}

// ---------- compiled rules ----------

#[derive(Debug, Clone)]
pub enum Reader {
    Json(Vec<JSeg>),
    Xpath(Vec<XStep>),
    Header(String),
    Cookie(String),
    Regex(regex::Regex),
    Status,
    Latency,
    Body,
}

impl Reader {
    /// All values the reader finds in the response.
    pub fn read(&self, r: &Resp<'_>) -> Result<Vec<String>, String> {
        Ok(match self {
            Reader::Json(p) => {
                let v = r.json().ok_or("response body isn't JSON")?;
                eval_jsonpath(v, p).into_iter().map(json_text).collect()
            }
            Reader::Xpath(p) => {
                let text = r.text();
                let doc = roxmltree::Document::parse(&text).map_err(|e| format!("response body isn't XML: {e}"))?;
                eval_xpath(&doc, p)
            }
            Reader::Header(h) => r.header_values(h),
            Reader::Cookie(c) => r.set_cookies(c),
            Reader::Regex(re) => re
                .captures_iter(&r.text())
                .map(|c| c.get(1).or_else(|| c.get(0)).map_or(String::new(), |m| m.as_str().to_string()))
                .collect(),
            Reader::Status => vec![r.status.to_string()],
            Reader::Latency => vec![format!("{:.3}", r.latency_ms)],
            Reader::Body => vec![r.text().into_owned()],
        })
    }
}

fn compile_reader(source: &ExtractSource, expr: &str) -> Result<Reader, String> {
    Ok(match source {
        ExtractSource::Json => Reader::Json(parse_jsonpath(expr)?),
        ExtractSource::Xpath => Reader::Xpath(parse_xpath(expr)?),
        ExtractSource::Header if expr.trim().is_empty() => return Err("name the header to read".into()),
        ExtractSource::Header => Reader::Header(expr.trim().to_string()),
        ExtractSource::Cookie if expr.trim().is_empty() => return Err("name the cookie to read".into()),
        ExtractSource::Cookie => Reader::Cookie(expr.trim().to_string()),
        ExtractSource::Regex => Reader::Regex(regex::Regex::new(expr).map_err(|e| format!("invalid regex: {e}"))?),
        ExtractSource::Status => Reader::Status,
        ExtractSource::Latency => Reader::Latency,
    })
}

#[derive(Debug, Clone)]
pub struct CompiledExtractor {
    pub spec: Extractor,
    pub reader: Reader,
}

pub fn compile_extractor(e: &Extractor) -> Result<CompiledExtractor, String> {
    Ok(CompiledExtractor { spec: e.clone(), reader: compile_reader(&e.source, &e.expr)? })
}

/// What an extractor produced: `Ok(Some)` a value, `Ok(None)` nothing found, `Err` a reason.
pub fn run_extractor(e: &CompiledExtractor, r: &Resp<'_>, rng: &mut fastrand::Rng) -> Result<Option<String>, String> {
    let values = e.reader.read(r)?;
    if values.is_empty() {
        return Ok(None);
    }
    Ok(match e.spec.pick {
        ExtractPick::First => values.first().cloned(),
        ExtractPick::Last => values.last().cloned(),
        ExtractPick::Random => Some(values[rng.usize(..values.len())].clone()),
        ExtractPick::Index => values.get(e.spec.index as usize).cloned(),
        ExtractPick::All => Some(serde_json::to_string(&values).expect("strings serialize")),
    })
}

#[derive(Debug, Clone)]
pub struct CompiledCheck {
    pub spec: Check,
    pub reader: Reader,
    pub re: Option<regex::Regex>,
    pub range: Option<(f64, f64)>,
}

pub fn check_label(c: &Check) -> String {
    let subject = match c.kind {
        CheckKind::Status => "status".to_string(),
        CheckKind::Body => "body".to_string(),
        CheckKind::Json => format!("json {}", c.expr.trim()),
        CheckKind::Xpath => format!("xpath {}", c.expr.trim()),
        CheckKind::Header => format!("header {}", c.expr.trim()),
        CheckKind::Latency => "latency".to_string(),
    };
    let op = match c.op {
        CheckOp::Equals => "=",
        CheckOp::NotEquals => "≠",
        CheckOp::Contains => "contains",
        CheckOp::NotContains => "doesn't contain",
        CheckOp::Matches => "matches",
        CheckOp::Exists => "exists",
        CheckOp::Missing => "is missing",
        CheckOp::Lt => "<",
        CheckOp::Lte => "≤",
        CheckOp::Gt => ">",
        CheckOp::Gte => "≥",
        CheckOp::InRange => "in",
    };
    let unit = if c.kind == CheckKind::Latency { " ms" } else { "" };
    match c.op {
        CheckOp::Exists | CheckOp::Missing => format!("{subject} {op}"),
        _ => format!("{subject} {op} {}{unit}", c.value.trim()),
    }
}

fn parse_range(v: &str) -> Option<(f64, f64)> {
    let (a, b) = v.split_once('-')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

pub fn compile_check(c: &Check) -> Result<CompiledCheck, String> {
    let reader = match c.kind {
        CheckKind::Status => Reader::Status,
        CheckKind::Body => Reader::Body,
        CheckKind::Json => Reader::Json(parse_jsonpath(&c.expr)?),
        CheckKind::Xpath => Reader::Xpath(parse_xpath(&c.expr)?),
        CheckKind::Header if c.expr.trim().is_empty() => return Err("name the header to check".into()),
        CheckKind::Header => Reader::Header(c.expr.trim().to_string()),
        CheckKind::Latency => Reader::Latency,
    };
    let re = match c.op {
        CheckOp::Matches => Some(regex::Regex::new(&c.value).map_err(|e| format!("invalid regex: {e}"))?),
        _ => None,
    };
    let range = match c.op {
        CheckOp::InRange => Some(parse_range(&c.value).ok_or("write the range as min-max, like 200-299")?),
        _ => None,
    };
    if matches!(c.op, CheckOp::Lt | CheckOp::Lte | CheckOp::Gt | CheckOp::Gte) && c.value.trim().parse::<f64>().is_err() {
        return Err("compare against a number".into());
    }
    Ok(CompiledCheck { spec: c.clone(), reader, re, range })
}

pub fn compare(op: &CheckOp, actual: Option<&str>, expected: &str, re: Option<&regex::Regex>, range: Option<(f64, f64)>) -> bool {
    let num = |s: &str| s.trim().parse::<f64>().ok();
    match op {
        CheckOp::Exists => actual.is_some(),
        CheckOp::Missing => actual.is_none(),
        _ => {
            let Some(a) = actual else { return false };
            match op {
                CheckOp::Equals => a == expected || matches!((num(a), num(expected)), (Some(x), Some(y)) if x == y),
                CheckOp::NotEquals => !(a == expected || matches!((num(a), num(expected)), (Some(x), Some(y)) if x == y)),
                CheckOp::Contains => a.contains(expected),
                CheckOp::NotContains => !a.contains(expected),
                CheckOp::Matches => re.is_some_and(|r| r.is_match(a)),
                CheckOp::InRange => matches!((num(a), range), (Some(x), Some((lo, hi))) if x >= lo && x <= hi),
                CheckOp::Lt | CheckOp::Lte | CheckOp::Gt | CheckOp::Gte => match (num(a), num(expected)) {
                    (Some(x), Some(y)) => match op {
                        CheckOp::Lt => x < y,
                        CheckOp::Lte => x <= y,
                        CheckOp::Gt => x > y,
                        _ => x >= y,
                    },
                    _ => false,
                },
                CheckOp::Exists | CheckOp::Missing => unreachable!(),
            }
        }
    }
}

/// (passed, what was actually there).
pub fn run_check(c: &CompiledCheck, r: &Resp<'_>) -> (bool, String) {
    match c.reader.read(r) {
        Ok(values) => {
            let first = values.first().map(String::as_str);
            let passed = compare(&c.spec.op, first, c.spec.value.trim(), c.re.as_ref(), c.range);
            let mut actual = first.map_or_else(|| "(missing)".to_string(), str::to_string);
            if actual.len() > 200 {
                let mut cut = 200;
                while !actual.is_char_boundary(cut) {
                    cut -= 1;
                }
                actual.truncate(cut);
                actual.push('…');
            }
            (passed, actual)
        }
        Err(e) => (matches!(c.spec.op, CheckOp::Missing), e),
    }
}

// ---------- Run if ----------

#[derive(Debug, Clone)]
pub struct CompiledRunIf {
    pub mode: MatchMode,
    pub clauses: Vec<(Clause, Option<regex::Regex>)>,
}

pub fn compile_run_if(r: &RunIf) -> Result<CompiledRunIf, String> {
    let clauses = r
        .clauses
        .iter()
        .map(|c| {
            let re = match c.op {
                ClauseOp::Matches => Some(regex::Regex::new(&c.value).map_err(|e| format!("invalid regex: {e}"))?),
                _ => None,
            };
            if c.subject == ClauseSubject::Variable && c.name.trim().is_empty() {
                return Err("name the variable this rule reads".to_string());
            }
            Ok((c.clone(), re))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(CompiledRunIf { mode: r.mode.clone(), clauses })
}

/// The previous request step's result in this iteration.
#[derive(Debug, Clone, Copy, Default)]
pub struct Prev {
    pub status: Option<u16>,
    pub ok: Option<bool>,
}

pub fn eval_run_if(r: &CompiledRunIf, lookup: &dyn Fn(&str) -> Option<String>, prev: Prev) -> bool {
    if r.clauses.is_empty() {
        return true;
    }
    let eval = |(c, re): &(Clause, Option<regex::Regex>)| -> bool {
        let actual: Option<String> = match c.subject {
            ClauseSubject::Variable => lookup(c.name.trim()),
            ClauseSubject::PrevStatus => prev.status.map(|s| s.to_string()),
            ClauseSubject::PrevOutcome => {
                return match c.op {
                    ClauseOp::Ok => prev.ok == Some(true),
                    ClauseOp::Failed => prev.ok == Some(false),
                    _ => false,
                };
            }
        };
        let op = match c.op {
            ClauseOp::Exists => CheckOp::Exists,
            ClauseOp::Missing => CheckOp::Missing,
            ClauseOp::Equals => CheckOp::Equals,
            ClauseOp::NotEquals => CheckOp::NotEquals,
            ClauseOp::Matches => CheckOp::Matches,
            ClauseOp::Lt => CheckOp::Lt,
            ClauseOp::Lte => CheckOp::Lte,
            ClauseOp::Gt => CheckOp::Gt,
            ClauseOp::Gte => CheckOp::Gte,
            ClauseOp::Ok => return prev.ok == Some(true),
            ClauseOp::Failed => return prev.ok == Some(false),
        };
        compare(&op, actual.as_deref(), c.value.trim(), re.as_ref(), None)
    };
    match r.mode {
        MatchMode::All => r.clauses.iter().all(eval),
        MatchMode::Any => r.clauses.iter().any(eval),
    }
}

/// Short text for a Run if rule, e.g. "if cart.size > 0".
pub fn run_if_label(r: &RunIf) -> String {
    let parts: Vec<String> = r
        .clauses
        .iter()
        .map(|c| {
            let subject = match c.subject {
                ClauseSubject::Variable => c.name.trim().to_string(),
                ClauseSubject::PrevStatus => "previous status".into(),
                ClauseSubject::PrevOutcome => "previous step".into(),
            };
            let op = match c.op {
                ClauseOp::Exists => return format!("{subject} exists"),
                ClauseOp::Missing => return format!("{subject} is missing"),
                ClauseOp::Ok => return format!("{subject} ok"),
                ClauseOp::Failed => return format!("{subject} failed"),
                ClauseOp::Equals => "=",
                ClauseOp::NotEquals => "≠",
                ClauseOp::Matches => "matches",
                ClauseOp::Lt => "<",
                ClauseOp::Lte => "≤",
                ClauseOp::Gt => ">",
                ClauseOp::Gte => "≥",
            };
            format!("{subject} {op} {}", c.value.trim())
        })
        .collect();
    let joiner = if r.mode == MatchMode::All { " and " } else { " or " };
    format!("if {}", parts.join(joiner))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn jsonpath_subset() {
        let v = json!({"data": {"token": "t1", "items": [{"id": 1}, {"id": 2}, {"id": 3}]}, "a.b": 5});
        let get = |p: &str| eval_jsonpath(&v, &parse_jsonpath(p).unwrap()).into_iter().map(json_text).collect::<Vec<_>>();
        assert_eq!(get("$.data.token"), ["t1"]);
        assert_eq!(get("data.token"), ["t1"]);
        assert_eq!(get("$.data.items[*].id"), ["1", "2", "3"]);
        assert_eq!(get("$.data.items[-1].id"), ["3"]);
        assert_eq!(get("$..id"), ["1", "2", "3"]);
        assert_eq!(get("$['a.b']"), ["5"]);
        assert_eq!(get("$.data.items[9]"), Vec::<String>::new());
        assert!(parse_jsonpath("$.a[").is_err());
        assert!(parse_jsonpath("$.a[x]").is_err());
    }

    #[test]
    fn xpath_subset() {
        let xml = r#"<?xml version="1.0"?><soap:Envelope xmlns:soap="urn:s"><soap:Body>
            <order id="o1"><item sku="a">Apple</item><item sku="b">Pear</item></order></soap:Body></soap:Envelope>"#;
        let doc = roxmltree::Document::parse(xml).unwrap();
        let get = |p: &str| eval_xpath(&doc, &parse_xpath(p).unwrap());
        assert_eq!(get("//item"), ["Apple", "Pear"]);
        assert_eq!(get("//item[2]"), ["Pear"]);
        assert_eq!(get("//order/@id"), ["o1"]);
        assert_eq!(get("//item[@sku='b']/text()"), ["Pear"]);
        assert_eq!(get("/Envelope/Body/order/item[1]"), ["Apple"]);
        assert_eq!(get("item"), ["Apple", "Pear"]);
        assert!(parse_xpath("//item[0]").is_err());
    }

    fn resp<'a>(status: u16, headers: &'a [(String, String)], body: &'a str) -> Resp<'a> {
        Resp::new(status, headers, body.as_bytes(), 12.5)
    }

    #[test]
    fn extractors() {
        let headers = vec![
            ("Set-Cookie".to_string(), "sid=abc; Path=/; HttpOnly".to_string()),
            ("X-Req".to_string(), "r-1".to_string()),
        ];
        let r = resp(201, &headers, r#"{"token":"t1","ids":[4,5]} order=99"#);
        let mut rng = fastrand::Rng::with_seed(1);
        let ex = |source: ExtractSource, expr: &str, pick: ExtractPick| {
            let e = Extractor {
                id: "e".into(), var: "v".into(), source, expr: expr.into(), pick, index: 1, default: String::new(),
                on_missing: OnMissing::FailStep, secret: false, enabled: true,
            };
            compile_extractor(&e).unwrap()
        };
        let body_json = r#"{"token":"t1","ids":[4,5]}"#;
        let rj = resp(200, &headers, body_json);
        assert_eq!(run_extractor(&ex(ExtractSource::Json, "$.token", ExtractPick::First), &rj, &mut rng).unwrap().as_deref(), Some("t1"));
        assert_eq!(run_extractor(&ex(ExtractSource::Json, "$.ids[*]", ExtractPick::All), &rj, &mut rng).unwrap().as_deref(), Some(r#"["4","5"]"#));
        assert_eq!(run_extractor(&ex(ExtractSource::Json, "$.ids[*]", ExtractPick::Index), &rj, &mut rng).unwrap().as_deref(), Some("5"));
        assert_eq!(run_extractor(&ex(ExtractSource::Json, "$.nope", ExtractPick::First), &rj, &mut rng).unwrap(), None);
        assert!(run_extractor(&ex(ExtractSource::Json, "$.token", ExtractPick::First), &r, &mut rng).is_err());
        assert_eq!(run_extractor(&ex(ExtractSource::Cookie, "sid", ExtractPick::First), &r, &mut rng).unwrap().as_deref(), Some("abc"));
        assert_eq!(run_extractor(&ex(ExtractSource::Header, "x-req", ExtractPick::First), &r, &mut rng).unwrap().as_deref(), Some("r-1"));
        assert_eq!(run_extractor(&ex(ExtractSource::Regex, r"order=(\d+)", ExtractPick::First), &r, &mut rng).unwrap().as_deref(), Some("99"));
        assert_eq!(run_extractor(&ex(ExtractSource::Status, "", ExtractPick::First), &r, &mut rng).unwrap().as_deref(), Some("201"));
    }

    #[test]
    fn checks() {
        let headers = vec![("Content-Type".to_string(), "application/json".to_string())];
        let r = resp(204, &headers, r#"{"count": 3, "name": "toad"}"#);
        let check = |kind: CheckKind, expr: &str, op: CheckOp, value: &str| {
            let c = Check { id: "c".into(), kind, expr: expr.into(), op, value: value.into(), fails_request: true, enabled: true };
            run_check(&compile_check(&c).unwrap(), &r).0
        };
        assert!(check(CheckKind::Status, "", CheckOp::InRange, "200-299"));
        assert!(!check(CheckKind::Status, "", CheckOp::Equals, "200"));
        assert!(check(CheckKind::Json, "$.count", CheckOp::Gt, "2"));
        assert!(check(CheckKind::Json, "$.count", CheckOp::Equals, "3.0"));
        assert!(check(CheckKind::Json, "$.missing", CheckOp::Missing, ""));
        assert!(check(CheckKind::Header, "content-type", CheckOp::Contains, "json"));
        assert!(check(CheckKind::Body, "", CheckOp::Matches, r#""name":\s*"toad""#));
        assert!(check(CheckKind::Latency, "", CheckOp::Lt, "50"));
        let bad = Check { id: "c".into(), kind: CheckKind::Status, expr: String::new(), op: CheckOp::InRange, value: "2xx".into(), fails_request: true, enabled: true };
        assert!(compile_check(&bad).is_err());
    }

    #[test]
    fn run_if_rules() {
        let rule = |mode: MatchMode, clauses: Vec<Clause>| compile_run_if(&RunIf { mode, clauses }).unwrap();
        let var = |name: &str, op: ClauseOp, value: &str| Clause { subject: ClauseSubject::Variable, name: name.into(), op, value: value.into() };
        let vars = |n: &str| match n {
            "cart.size" => Some("2".to_string()),
            "plan" => Some("pro".to_string()),
            _ => None,
        };
        let prev = Prev { status: Some(404), ok: Some(false) };
        assert!(eval_run_if(&rule(MatchMode::All, vec![var("cart.size", ClauseOp::Gt, "0"), var("plan", ClauseOp::Equals, "pro")]), &vars, prev));
        assert!(!eval_run_if(&rule(MatchMode::All, vec![var("cart.size", ClauseOp::Gt, "0"), var("token", ClauseOp::Exists, "")]), &vars, prev));
        assert!(eval_run_if(&rule(MatchMode::Any, vec![var("token", ClauseOp::Exists, ""), var("plan", ClauseOp::Matches, "^p")]), &vars, prev));
        let st = Clause { subject: ClauseSubject::PrevStatus, name: String::new(), op: ClauseOp::Equals, value: "404".into() };
        let failed = Clause { subject: ClauseSubject::PrevOutcome, name: String::new(), op: ClauseOp::Failed, value: String::new() };
        assert!(eval_run_if(&rule(MatchMode::All, vec![st, failed]), &vars, prev));
        assert!(eval_run_if(&rule(MatchMode::All, vec![]), &vars, prev));
        assert_eq!(
            run_if_label(&RunIf { mode: MatchMode::All, clauses: vec![var("cart.size", ClauseOp::Gt, "0")] }),
            "if cart.size > 0"
        );
    }
}
