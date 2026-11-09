//! Static validation of a test. Field keys say where a problem lives so the UI can put it on
//! the right stage and field: `name`, `step:<id>.url`, `scenario:<id>.load`, `data:<id>`,
//! `threshold:<id>`, `env.var.<i>`, `connection.proxy`, `defaults.timeout_ms`, …

use crate::extract::{compile_check, compile_extractor, compile_run_if, parse_jsonpath};
use crate::models::{FieldError, Limits};
use crate::spec::*;
use crate::template::{Template, BUILTINS};
use std::collections::HashSet;

const TOKEN: fn(char) -> bool = |c: char| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c);
const MAX_SECS: u64 = 24 * 3600;

fn err(field: impl Into<String>, message: impl Into<String>) -> FieldError {
    FieldError { field: field.into(), message: message.into() }
}

fn valid_var_name(n: &str) -> bool {
    !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

struct Ctx {
    errors: Vec<FieldError>,
    limits: Limits,

}

impl Ctx {
    fn push(&mut self, field: impl Into<String>, message: impl Into<String>) {
        self.errors.push(err(field, message));
    }

    /// Parse a template and check every variable it reads is defined at this point.
    fn tpl(&mut self, field: &str, text: &str, defined: &HashSet<String>) -> Option<Template> {
        match Template::parse(text) {
            Ok(t) => {
                for v in t.vars() {
                    if !defined.contains(&v) {
                        self.push(field.to_string(), format!("`{v}` isn't defined before this step. Define it in Data, or extract it in an earlier step"));
                        break;
                    }
                }
                Some(t)
            }
            Err(e) => {
                self.push(field.to_string(), format!("Template error: {e}"));
                None
            }
        }
    }

    fn header_rows(&mut self, prefix: &str, rows: &[KeyValue], defined: &HashSet<String>) {
        for (i, h) in rows.iter().enumerate().filter(|(_, h)| h.enabled) {
            let field = format!("{prefix}.{i}");
            let name = h.name.trim();
            if name.is_empty() {
                self.push(&field, "Name this header, or switch it off");
            } else if !name.chars().all(TOKEN) {
                self.push(&field, "Header names can't contain spaces or : ( ) , ; \" / [ ] { } < > = ? @");
            } else if h.value.contains(['\r', '\n']) {
                self.push(&field, "Header value has a line break");
            } else {
                self.tpl(&field, &h.value, defined);
            }
        }
    }

    fn step(&mut self, s: &RequestStep, defined: &HashSet<String>) -> HashSet<String> {
        let id = format!("step:{}", s.id);
        let mut d = defined.clone();
        for (i, v) in s.values.iter().enumerate().filter(|(_, v)| v.enabled) {
            let field = format!("{id}.values.{i}");
            if !valid_var_name(v.name.trim()) {
                self.push(&field, "Value names use letters, digits, `_`, `-` and `.`");
                continue;
            }
            self.tpl(&field, &v.value, &d);
            d.insert(v.name.trim().to_string());
        }
        let method = s.method.trim();
        if method.is_empty() || !method.chars().all(TOKEN) {
            self.push(format!("{id}.method"), "Use a method like GET or POST (letters only)");
        }
        let url = s.url.trim();
        if url.is_empty() {
            self.push(format!("{id}.url"), "Enter the URL to request");
        } else if let Some(t) = self.tpl(&format!("{id}.url"), url, &d) {
            if let Some(lit) = t.as_literal() {
                match url::Url::parse(&lit) {
                    Ok(u) if u.scheme() != "http" && u.scheme() != "https" => self.push(format!("{id}.url"), "URL must start with http:// or https://"),
                    Ok(u) if u.host_str().is_none_or(str::is_empty) => self.push(format!("{id}.url"), "URL has no host"),
                    Ok(_) => {}
                    Err(e) => self.push(format!("{id}.url"), format!("Enter a full URL, like https://api.example.com/users ({e})")),
                }
            } else if !(url.starts_with("{{") || url.starts_with("http://") || url.starts_with("https://")) {
                self.push(format!("{id}.url"), "URL must start with http://, https:// or a variable like {{baseUrl}}");
            }
        }
        for (i, p) in s.params.iter().enumerate().filter(|(_, p)| p.enabled) {
            let field = format!("{id}.params.{i}");
            if p.name.trim().is_empty() {
                self.push(&field, "Name this parameter, or switch it off");
            } else {
                self.tpl(&field, &p.name, &d);
                self.tpl(&field, &p.value, &d);
            }
        }
        self.header_rows(&format!("{id}.headers"), &s.headers, &d);
        for (i, ck) in s.cookies.iter().enumerate().filter(|(_, c)| c.enabled) {
            let field = format!("{id}.cookies.{i}");
            if ck.name.trim().is_empty() || ck.name.contains([';', '=', ' ']) {
                self.push(&field, "Cookie names can't be empty or contain ; = or spaces");
            } else {
                self.tpl(&field, &ck.value, &d);
            }
        }
        if let Some(b) = &s.body {
            let field = format!("{id}.body");
            match b.kind {
                BodyKind::Json | BodyKind::Xml | BodyKind::Text | BodyKind::Raw => {
                    if let Some(t) = self.tpl(&field, &b.content, &d) {
                        let text = t.placeholder_text();
                        if b.kind == BodyKind::Json && !text.trim().is_empty() {
                            if let Err(e) = serde_json::from_str::<serde_json::Value>(&text) {
                                self.push(&field, format!("Not valid JSON (with templates filled in): {e}"));
                            }
                        }
                        if b.kind == BodyKind::Xml && !text.trim().is_empty() {
                            if let Err(e) = roxmltree::Document::parse(&text) {
                                self.push(&field, format!("Not valid XML: {e}"));
                            }
                        }
                    }
                }
                BodyKind::Graphql => {
                    if b.content.trim().is_empty() {
                        self.push(&field, "Write the GraphQL query");
                    }
                    self.tpl(&field, &b.content, &d);
                    if let Some(t) = self.tpl(&field, &b.variables, &d) {
                        let text = t.placeholder_text();
                        if !text.trim().is_empty() && serde_json::from_str::<serde_json::Value>(&text).is_err() {
                            self.push(&field, "GraphQL variables must be a JSON object");
                        }
                    }
                }
                BodyKind::Form | BodyKind::Multipart => {
                    for (i, f) in b.fields.iter().enumerate().filter(|(_, f)| f.enabled) {
                        if f.name.trim().is_empty() {
                            self.push(format!("{field}.{i}"), "Name this field, or switch it off");
                        } else if f.file && b.kind == BodyKind::Multipart {
                            if f.value.trim().is_empty() {
                                self.push(format!("{field}.{i}"), "Choose a file for this field");
                            }
                        } else {
                            self.tpl(&format!("{field}.{i}"), &f.value, &d);
                        }
                    }
                }
                BodyKind::Binary => {
                    if b.file.as_deref().is_none_or(|f| f.trim().is_empty()) {
                        self.push(&field, "Choose the file to send");
                    }
                }
            }
            if !b.content_type.is_empty() && b.content_type.contains(['\r', '\n']) {
                self.push(&field, "Content-Type has a line break");
            }
        }
        match &s.auth {
            Auth::Bearer { token } => {
                self.tpl(&format!("{id}.auth"), token, &d);
            }
            Auth::Basic { username, password } => {
                self.tpl(&format!("{id}.auth"), username, &d);
                self.tpl(&format!("{id}.auth"), password, &d);
            }
            Auth::ApiKey { name, value, .. } => {
                if name.trim().is_empty() {
                    self.push(format!("{id}.auth"), "Name the API key header or parameter");
                }
                self.tpl(&format!("{id}.auth"), value, &d);
            }
            Auth::Inherit | Auth::None => {}
        }
        if let Some(t) = s.timeout_ms {
            if !(1..=300_000).contains(&t) {
                self.push(format!("{id}.timeout"), "Use a timeout from 1 to 300000 ms");
            }
        }
        if let Some(r) = &s.run_if {
            if let Err(e) = compile_run_if(r) {
                self.push(format!("{id}.run_if"), e);
            }
        }
        for c in s.checks.iter().filter(|c| c.enabled) {
            if let Err(e) = compile_check(c) {
                self.push(format!("{id}.checks.{}", c.id), e);
            }
        }
        let mut out = defined.clone();
        let mut seen = HashSet::new();
        for e in s.extract.iter().filter(|e| e.enabled) {
            let field = format!("{id}.extract.{}", e.id);
            if !valid_var_name(e.var.trim()) {
                self.push(&field, "Name the variable (letters, digits, `_`, `-`, `.`)");
                continue;
            }
            if !seen.insert(e.var.trim().to_string()) {
                self.push(&field, format!("`{}` is extracted twice in this step", e.var.trim()));
            }
            if e.source == ExtractSource::Json {
                if let Err(m) = parse_jsonpath(&e.expr) {
                    self.push(&field, format!("JSONPath: {m}"));
                    continue;
                }
            }
            if let Err(m) = compile_extractor(e) {
                self.push(&field, m);
            }
            out.insert(e.var.trim().to_string());
        }
        out
    }

    fn items(&mut self, items: &[FlowItem], defined: &HashSet<String>, ordered: bool) -> HashSet<String> {
        let mut d = defined.clone();
        let mut all = defined.clone();
        for item in items {
            match item {
                FlowItem::Request { step } => {
                    let out = self.step(step, if ordered { &d } else { defined });
                    all.extend(out.iter().cloned());
                    if ordered {
                        d = out;
                    }
                }
                FlowItem::Group { group } => {
                    if group.steps.is_empty() {
                        self.push(format!("group:{}", group.id), "Add at least one request to this parallel group");
                    }
                    if let Some(r) = &group.run_if {
                        if let Err(e) = compile_run_if(r) {
                            self.push(format!("group:{}.run_if", group.id), e);
                        }
                    }
                    let mut merged = d.clone();
                    for s in &group.steps {
                        merged.extend(self.step(s, &d));
                    }
                    all.extend(merged.iter().cloned());
                    d = merged;
                }
                FlowItem::Pause { pause } => {
                    if let ThinkTime::Uniform { min_ms, max_ms } = pause.think {
                        if min_ms > max_ms {
                            self.push(format!("pause:{}", pause.id), "Minimum is above maximum");
                        }
                    }
                    if let Some(r) = &pause.run_if {
                        if let Err(e) = compile_run_if(r) {
                            self.push(format!("pause:{}.run_if", pause.id), e);
                        }
                    }
                }
            }
        }
        if ordered { d } else { all }
    }

    fn executor(&mut self, sc: &Scenario) {
        let field = format!("scenario:{}.load", sc.id);
        let dur_ok = |s: u64| (1..=MAX_SECS).contains(&s);
        match &sc.executor {
            Executor::Vus { vus, duration_secs } => {
                if *vus == 0 {
                    self.push(&field, "Use at least 1 virtual user");
                }
                if !dur_ok(u64::from(*duration_secs)) {
                    self.push(&field, "Run for 1 s to 24 h");
                }
            }
            Executor::RampingVus { stages, .. } | Executor::RampingRate { stages, .. } => {
                if stages.is_empty() {
                    self.push(&field, "Add at least one stage");
                } else if !dur_ok(sc.executor.duration_secs()) {
                    self.push(&field, "Stages must add up to 1 s – 24 h");
                }
                if sc.executor.peak_vus() == 0 || sc.executor.peak_rate() == Some(0) {
                    self.push(&field, "At least one stage needs a target above 0");
                }
            }
            Executor::Rate { rate, duration_secs, .. } => {
                if *rate == 0 {
                    self.push(&field, "Start at least 1 iteration per second");
                }
                if !dur_ok(u64::from(*duration_secs)) {
                    self.push(&field, "Run for 1 s to 24 h");
                }
            }
            Executor::Iterations { vus, iterations, max_duration_secs } => {
                if *vus == 0 {
                    self.push(&field, "Use at least 1 virtual user");
                }
                if *iterations == 0 {
                    self.push(&field, "Run at least 1 iteration");
                }
                if !dur_ok(u64::from(*max_duration_secs)) {
                    self.push(&field, "Allow 1 s to 24 h");
                }
            }
        }
        if let Executor::Rate { max_vus, .. } | Executor::RampingRate { max_vus, .. } = sc.executor {
            if max_vus == 0 {
                self.push(&field, "Allow at least 1 virtual user");
            }
        }
        if sc.graceful_stop_secs > 300 {
            self.push(format!("scenario:{}.graceful", sc.id), "Graceful stop is at most 300 s");
        }
        if let Some(ThinkTime::Uniform { min_ms, max_ms }) = sc.think {
            if min_ms > max_ms {
                self.push(format!("scenario:{}.think", sc.id), "Minimum is above maximum");
            }
        }
    }
}

/// Names every step can read before any step runs: environment variables, data columns,
/// `baseUrl`, and the built-ins.
pub fn base_names(c: &TestConfig) -> HashSet<String> {
    let mut d: HashSet<String> = BUILTINS.iter().map(|s| s.to_string()).collect();
    for v in &c.variables {
        d.insert(v.name.trim().to_string());
    }
    if !c.defaults.base_url.trim().is_empty() {
        d.insert("baseUrl".into());
    }
    for f in &c.data {
        for col in &f.columns {
            d.insert(format!("{}.{}", f.name.trim(), col));
        }
    }
    d
}

pub fn validate(c: &TestConfig, limits: Limits) -> Vec<FieldError> {
    let mut x = Ctx { errors: Vec::new(), limits };
    if c.name.trim().is_empty() {
        x.push("name", "Give the test a name");
    }
    let d = &c.defaults;
    if !(1..=300_000).contains(&d.timeout_ms) {
        x.push("defaults.timeout_ms", "Use a timeout from 1 to 300000 ms (5 minutes)");
    }
    let r = &d.success_range;
    if r.min < 100 || r.max > 599 || r.min > r.max {
        x.push("defaults.success_range", "Use codes from 100 to 599, with the first no higher than the second");
    }
    if d.max_redirects > 20 {
        x.push("defaults.max_redirects", "Follow at most 20 redirects");
    }
    if d.base_url.trim().contains("{{") {
        x.push("defaults.base_url", "The base URL can't contain templates; use an environment variable instead");
    }
    if c.warmup_secs > 3600 {
        x.push("warmup_secs", "Warm-up is at most 3600 s");
    }

    // Data and variables.
    let mut names = HashSet::new();
    for (i, v) in c.variables.iter().enumerate() {
        let n = v.name.trim();
        if !valid_var_name(n) {
            x.push(format!("env.var.{i}"), "Variable names use letters, digits, `_`, `-` and `.`");
        } else if !names.insert(n.to_string()) {
            x.push(format!("env.var.{i}"), format!("`{n}` is defined twice"));
        }
    }
    if !c.active_env.is_empty() && c.active_environment().is_none() {
        x.push("env.active", "The selected environment no longer exists");
    }
    let peak_vus: u32 = c.enabled_scenarios().map(|s| s.executor.peak_vus()).sum();
    let mut data_names = HashSet::new();
    for f in &c.data {
        let field = format!("data:{}", f.id);
        let n = f.name.trim();
        if n.is_empty() || n.contains('.') || !valid_var_name(n) {
            x.push(&field, "Name the file with letters, digits, `_` or `-` (it's how templates read it: {{name.column}})");
        } else if !data_names.insert(n.to_string()) {
            x.push(&field, format!("Another data file is also called `{n}`"));
        }
        if f.distribution == Distribution::UniquePerVu && f.rows < u64::from(peak_vus) {
            x.push(&field, format!("Unique per virtual user needs a row for each one: {} rows, up to {peak_vus} virtual users", f.rows));
        }
    }

    // Steps.
    let base = base_names(c);
    let mut global = base.clone();
    for s in &c.setup {
        global = x.step(s, &global);
    }
    let mut step_ids = HashSet::new();
    for r in c.all_steps() {
        if !step_ids.insert(r.step.id.clone()) {
            x.push(format!("step:{}", r.step.id), "Two steps share an id; duplicate the step again to fix it");
        }
    }
    let enabled: Vec<&Scenario> = c.enabled_scenarios().collect();
    if enabled.is_empty() {
        x.push("scenarios", "Turn on at least one scenario");
    }
    let mut scen_names = HashSet::new();
    for sc in &c.scenarios {
        if !scen_names.insert(sc.name.trim().to_string()) {
            x.push(format!("scenario:{}.name", sc.id), "Two scenarios have this name");
        }
        if sc.steps.iter().all(|i| i.steps().is_empty()) {
            x.push(format!("scenario:{}", sc.id), "Add at least one request");
        }
        let after_init = x.items(&sc.init, &global, true);
        match sc.kind {
            ScenarioKind::Flow => {
                x.items(&sc.steps, &after_init, true);
            }
            ScenarioKind::Mix => {
                // Mix iterations run one step each, in random order: any step's extracts may be around.
                let mut pool = after_init.clone();
                for item in &sc.steps {
                    for st in item.steps() {
                        pool.extend(st.extract.iter().filter(|e| e.enabled).map(|e| e.var.trim().to_string()));
                    }
                }
                x.items(&sc.steps, &pool, false);
                for item in &sc.steps {
                    if !matches!(item, FlowItem::Request { .. }) {
                        x.push(format!("scenario:{}", sc.id), "A mix holds requests only; groups and pauses belong in a flow");
                        break;
                    }
                    if let FlowItem::Request { step } = item {
                        if step.weight == 0 {
                            x.push(format!("step:{}.weight", step.id), "Give the step a weight above 0, or remove it");
                        }
                    }
                }
            }
        }
        if sc.enabled {
            x.executor(sc);
        }
    }
    for s in &c.teardown {
        x.step(s, &global);
    }
    let rate: u64 = enabled.iter().filter_map(|s| s.executor.peak_rate()).map(u64::from).sum();
    if peak_vus > x.limits.max_concurrency {
        let field = enabled.first().map_or("scenarios".to_string(), |s| format!("scenario:{}.load", s.id));
        x.push(field, format!("Up to {peak_vus} virtual users across scenarios; Settings allow {}", x.limits.max_concurrency));
    }
    if rate > u64::from(x.limits.max_rps) {
        let field = enabled.iter().find(|s| s.executor.is_open()).map_or("scenarios".to_string(), |s| format!("scenario:{}.load", s.id));
        x.push(field, format!("Up to {rate} iterations/s across scenarios; Settings allow {} per second", x.limits.max_rps));
    }

    // Thresholds.
    let scen_ids: HashSet<&str> = c.scenarios.iter().map(|s| s.id.as_str()).collect();
    for t in c.thresholds.iter().filter(|t| t.enabled) {
        let field = format!("threshold:{}", t.id);
        let ok_scope = t.scope.is_empty()
            || t.scope.strip_prefix("scenario:").is_some_and(|id| scen_ids.contains(id))
            || t.scope.strip_prefix("step:").is_some_and(|id| step_ids.contains(id));
        if !ok_scope {
            x.push(&field, "Its scenario or step no longer exists");
        }
        if !t.value.is_finite() || t.value < 0.0 {
            x.push(&field, "Use a number of 0 or more");
        }
        if matches!(t.metric, ThresholdMetric::ErrorRate | ThresholdMetric::CheckPassRate) && t.value > 100.0 {
            x.push(&field, "Rates are percentages, 0–100");
        }
    }

    // Connection.
    let conn = &c.connection;
    if conn.proxy.enabled {
        let a = conn.proxy.address.trim();
        let hostport = a.split_once("://").map_or(a, |(_, r)| r);
        if a.is_empty() {
            x.push("connection.proxy", "Enter the proxy address, like 127.0.0.1:8888");
        } else if !hostport.rsplit_once(':').is_some_and(|(h, p)| !h.is_empty() && p.parse::<u16>().is_ok()) {
            x.push("connection.proxy", "Write the proxy as host:port");
        }
    }
    for (i, o) in conn.host_overrides.iter().enumerate() {
        let a = o.address.trim();
        let ok = a.parse::<std::net::IpAddr>().is_ok() || a.parse::<std::net::SocketAddr>().is_ok();
        if o.host.trim().is_empty() || !ok {
            x.push(format!("connection.host_overrides.{i}"), "Map a host name to an IP address, like api.local → 127.0.0.1");
        }
    }
    for cert in &conn.client_certs {
        if cert.cert_file.is_empty() {
            x.push(format!("connection.cert:{}", cert.id), "Choose the certificate file (PEM)");
        }
    }
    x.errors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_with(steps: Vec<RequestStep>) -> TestConfig {
        let mut c = TestConfig::blank("t", "http://localhost/");
        c.scenarios[0].steps = steps.into_iter().map(|step| FlowItem::Request { step }).collect();
        c
    }

    fn fields(c: &TestConfig) -> Vec<String> {
        validate(c, Limits::default()).into_iter().map(|e| e.field).collect()
    }

    #[test]
    fn blank_test_is_valid() {
        assert!(fields(&TestConfig::blank("t", "http://localhost:8787/")).is_empty());
    }

    #[test]
    fn variables_must_be_defined_before_use() {
        let mut login = RequestStep::new("login", "POST", "http://localhost/login");
        login.extract.push(Extractor {
            id: "e1".into(), var: "token".into(), source: ExtractSource::Json, expr: "$.token".into(), pick: ExtractPick::First,
            index: 0, default: String::new(), on_missing: OnMissing::SkipIteration, secret: true, enabled: true,
        });
        let mut orders = RequestStep::new("orders", "GET", "{{baseUrl}}/orders");
        orders.headers.push(KeyValue { name: "Authorization".into(), value: "Bearer {{token}}".into(), enabled: true });
        let mut c = test_with(vec![orders.clone(), login.clone()]);
        c.defaults.base_url = "http://localhost".into();
        assert_eq!(fields(&c), ["step:orders.headers.0"]);
        let mut c = test_with(vec![login, orders]);
        c.defaults.base_url = "http://localhost".into();
        assert!(fields(&c).is_empty(), "{:?}", validate(&c, Limits::default()));
    }

    #[test]
    fn bodies_and_urls() {
        let mut s = RequestStep::new("a", "POST", "localhost/x");
        s.body = Some(BodySpec { kind: BodyKind::Json, content: r#"{"n": {{$seq}}, "x": }"#.into(), fields: vec![], variables: String::new(), file: None, content_type: String::new(), gzip: false });
        assert_eq!(fields(&test_with(vec![s.clone()])), ["step:a.url", "step:a.body"]);
        s.url = "http://localhost/x".into();
        s.body.as_mut().unwrap().content = r#"{"n": {{$seq}}, "id": "{{$uuid}}"}"#.into();
        assert!(fields(&test_with(vec![s])).is_empty());
    }

    #[test]
    fn limits_and_executors() {
        let mut c = TestConfig::blank("t", "http://localhost/");
        c.scenarios[0].executor = Executor::Vus { vus: 2000, duration_secs: 10 };
        assert_eq!(fields(&c), ["scenario:s1.load"]);
        c.scenarios[0].executor = Executor::RampingRate { start: 0, stages: vec![], max_vus: 10 };
        assert!(fields(&c).contains(&"scenario:s1.load".to_string()));
        c.scenarios[0].enabled = false;
        assert!(fields(&c).contains(&"scenarios".to_string()));
    }

    #[test]
    fn data_and_thresholds() {
        let mut c = TestConfig::blank("t", "http://localhost/{{users.id}}");
        c.data.push(DataFile {
            id: "d1".into(), name: "users".into(), file: "f".into(), original_name: "u.csv".into(), format: DataFormat::Csv,
            has_header: true, columns: vec!["id".into()], secret_columns: vec![], rows: 3, distribution: Distribution::UniquePerVu,
            on_exhausted: OnExhausted::StopVu,
        });
        c.thresholds.push(Threshold { id: "t1".into(), metric: ThresholdMetric::P95, scope: "step:nope".into(), op: Cmp::Lt, value: 300.0, abort: false, delay_secs: 0, enabled: true });
        assert_eq!(fields(&c), ["data:d1", "threshold:t1"]);
    }
}
