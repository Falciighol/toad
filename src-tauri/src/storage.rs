//! JSON persistence in the app data dir:
//!   tests/{id}.json             saved test configs (v1 files load as v2)
//!   tests/{id}/                 the test's files: data files, certificates, upload bodies
//!   runs/{run_id}.json          one file per run (summary + per-second and per-endpoint series)
//!   runs/{run_id}.samples.json  captured requests and responses for that run
//!   runs/index.json             cache of run summaries without series (rebuildable)
//!   settings.json

use serde::{de::DeserializeOwned, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use toad_core::{RunSummary, Sample, Settings, TestConfig};

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("corrupt file {path}: {source}")]
    Json { path: String, source: serde_json::Error },
    #[error("invalid id {0:?}")]
    BadId(String),
    #[error("not found: {0}")]
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, StorageError>;

/// Only ids we generate (UUIDs) or similarly safe names may become file names.
pub fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn checked(id: &str) -> Result<&str> {
    if is_safe_id(id) {
        Ok(id)
    } else {
        Err(StorageError::BadId(id.to_string()))
    }
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let bytes = fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(|source| StorageError::Json { path: path.display().to_string(), source })
}

/// Write to a temp file in the same directory, then rename (atomic on all targets).
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).expect("model serializes");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Every file name a test refers to in its folder.
pub fn referenced_assets(c: &TestConfig) -> std::collections::HashSet<String> {
    let mut used = std::collections::HashSet::new();
    for f in &c.data {
        used.insert(f.file.clone());
    }
    for cert in &c.connection.client_certs {
        used.insert(cert.cert_file.clone());
        used.insert(cert.key_file.clone());
    }
    for r in c.all_steps() {
        if let Some(b) = &r.step.body {
            if let Some(f) = &b.file {
                used.insert(f.clone());
            }
            for field in b.fields.iter().filter(|f| f.file) {
                used.insert(field.value.clone());
            }
        }
    }
    used.remove("");
    used
}

pub struct Storage {
    root: PathBuf,
    /// Newest first.
    index: Mutex<Vec<RunSummary>>,
}

impl Storage {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(root.join("tests"))?;
        fs::create_dir_all(root.join("runs"))?;
        let s = Storage { root, index: Mutex::new(Vec::new()) };
        let index = match read_json::<Vec<RunSummary>>(&s.index_path()) {
            Ok(i) => i,
            Err(_) => s.rebuild_index()?,
        };
        *s.index.lock().unwrap() = index;
        Ok(s)
    }

    fn tests_dir(&self) -> PathBuf {
        self.root.join("tests")
    }
    fn runs_dir(&self) -> PathBuf {
        self.root.join("runs")
    }
    fn index_path(&self) -> PathBuf {
        self.runs_dir().join("index.json")
    }
    fn settings_path(&self) -> PathBuf {
        self.root.join("settings.json")
    }

    fn json_files(dir: &Path) -> Result<Vec<PathBuf>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(dir)? {
            let p = entry?.path();
            let stem_ok = p.file_stem().and_then(|s| s.to_str()).is_some_and(is_safe_id);
            if p.extension().is_some_and(|e| e == "json") && stem_ok {
                out.push(p);
            }
        }
        Ok(out)
    }

    fn rebuild_index(&self) -> Result<Vec<RunSummary>> {
        let mut runs: Vec<RunSummary> = Self::json_files(&self.runs_dir())?
            .iter()
            .filter(|p| p.file_name().is_some_and(|n| n != "index.json"))
            .filter(|p| !p.to_string_lossy().ends_with(".samples.json"))
            .filter_map(|p| read_json::<RunSummary>(p).ok())
            .map(|r| r.without_series())
            .collect();
        runs.sort_by_key(|r| std::cmp::Reverse(r.started_at));
        write_json(&self.index_path(), &runs)?;
        Ok(runs)
    }

    // ---- tests ----

    pub fn list_tests(&self) -> Result<Vec<TestConfig>> {
        let mut tests: Vec<TestConfig> =
            Self::json_files(&self.tests_dir())?.iter().filter_map(|p| read_json(p).ok()).collect();
        tests.sort_by_key(|t| std::cmp::Reverse(t.updated_at));
        Ok(tests)
    }

    pub fn get_test(&self, id: &str) -> Result<TestConfig> {
        let path = self.tests_dir().join(format!("{}.json", checked(id)?));
        if !path.exists() {
            return Err(StorageError::NotFound(id.into()));
        }
        read_json(&path)
    }

    pub fn save_test(&self, cfg: &TestConfig) -> Result<()> {
        write_json(&self.tests_dir().join(format!("{}.json", checked(&cfg.id)?)), cfg)?;
        // Files imported moments ago may belong to an edit that hasn't been saved yet.
        self.prune_assets(cfg, std::time::Duration::from_secs(600));
        Ok(())
    }

    pub fn delete_test(&self, id: &str) -> Result<()> {
        let path = self.tests_dir().join(format!("{}.json", checked(id)?));
        match fs::remove_file(path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        let _ = fs::remove_dir_all(self.tests_dir().join(id));
        Ok(())
    }

    /// The folder holding a test's files (data, certificates, upload bodies).
    pub fn test_dir(&self, id: &str) -> Result<PathBuf> {
        Ok(self.tests_dir().join(checked(id)?))
    }

    /// Copy a file the user picked into the test's folder. Returns the stored file name.
    pub fn import_asset(&self, id: &str, source: &Path) -> Result<(String, u64)> {
        let dir = self.test_dir(id)?;
        fs::create_dir_all(&dir)?;
        let original = source.file_name().and_then(|n| n.to_str()).unwrap_or("file");
        let clean: String = original.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect();
        let clean = clean.trim_start_matches('.').chars().take(80).collect::<String>();
        let name = format!("{}-{}", &uuid::Uuid::now_v7().simple().to_string()[20..], if clean.is_empty() { "file".into() } else { clean });
        let size = fs::copy(source, dir.join(&name))?;
        Ok((name, size))
    }

    pub fn read_asset(&self, id: &str, file: &str) -> Result<Vec<u8>> {
        if file.is_empty() || file.contains(['/', '\\']) || file.contains("..") {
            return Err(StorageError::BadId(file.into()));
        }
        Ok(fs::read(self.test_dir(id)?.join(file))?)
    }

    /// Remove files in the test folder that the test no longer references and that are
    /// older than `min_age`.
    pub fn prune_assets(&self, cfg: &TestConfig, min_age: std::time::Duration) {
        let Ok(dir) = self.test_dir(&cfg.id) else { return };
        let Ok(entries) = fs::read_dir(&dir) else { return };
        let used = referenced_assets(cfg);
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age >= min_age);
            if !used.contains(&name) && old {
                let _ = fs::remove_file(e.path());
            }
        }
    }

    /// Copy a test's folder to another test id (duplicate).
    pub fn copy_assets(&self, from: &str, to: &str) -> Result<()> {
        let (src, dst) = (self.test_dir(from)?, self.test_dir(to)?);
        if !src.is_dir() {
            return Ok(());
        }
        fs::create_dir_all(&dst)?;
        for e in fs::read_dir(src)?.flatten() {
            if e.path().is_file() {
                fs::copy(e.path(), dst.join(e.file_name()))?;
            }
        }
        Ok(())
    }

    // ---- runs ----

    pub fn list_runs(&self) -> Vec<RunSummary> {
        self.index.lock().unwrap().clone()
    }

    pub fn get_run(&self, run_id: &str) -> Result<RunSummary> {
        let path = self.runs_dir().join(format!("{}.json", checked(run_id)?));
        if !path.exists() {
            return Err(StorageError::NotFound(run_id.into()));
        }
        let mut r: RunSummary = read_json(&path)?;
        r.legacy = r.endpoints.is_empty();
        Ok(r)
    }

    pub fn save_samples(&self, run_id: &str, samples: &[Sample]) -> Result<()> {
        write_json(&self.runs_dir().join(format!("{}.samples.json", checked(run_id)?)), &samples)
    }

    /// A run's captured requests; empty for runs that have none (or predate them).
    pub fn get_samples(&self, run_id: &str) -> Result<Vec<Sample>> {
        let path = self.runs_dir().join(format!("{}.samples.json", checked(run_id)?));
        if !path.exists() {
            return Ok(vec![]);
        }
        read_json(&path)
    }

    /// Persist a run and prune history down to `keep` runs (oldest deleted first).
    pub fn save_run(&self, summary: &RunSummary, keep: usize) -> Result<()> {
        let id = checked(&summary.run_id)?;
        write_json(&self.runs_dir().join(format!("{id}.json")), summary)?;
        let mut index = self.index.lock().unwrap();
        index.retain(|r| r.run_id != summary.run_id);
        index.insert(0, summary.without_series());
        index.sort_by_key(|r| std::cmp::Reverse(r.started_at));
        while index.len() > keep.max(1) {
            if let Some(old) = index.pop() {
                let _ = fs::remove_file(self.runs_dir().join(format!("{}.json", old.run_id)));
                let _ = fs::remove_file(self.runs_dir().join(format!("{}.samples.json", old.run_id)));
            }
        }
        write_json(&self.index_path(), &*index)
    }

    pub fn delete_run(&self, run_id: &str) -> Result<()> {
        let id = checked(run_id)?;
        match fs::remove_file(self.runs_dir().join(format!("{id}.json"))) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        let _ = fs::remove_file(self.runs_dir().join(format!("{id}.samples.json")));
        let mut index = self.index.lock().unwrap();
        index.retain(|r| r.run_id != run_id);
        write_json(&self.index_path(), &*index)
    }

    // ---- settings ----

    pub fn load_settings(&self) -> Settings {
        read_json(&self.settings_path()).unwrap_or_default()
    }

    pub fn save_settings(&self, s: &Settings) -> Result<()> {
        write_json(&self.settings_path(), s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use toad_core::*;

    fn cfg(id: &str, updated_at: i64) -> TestConfig {
        let mut c = TestConfig::blank(id, "http://localhost");
        c.name = format!("test {id}");
        c.updated_at = updated_at;
        c
    }

    fn run(id: &str, started_at: i64) -> RunSummary {
        RunSummary {
            run_id: id.into(),
            config: cfg("t", 0),
            started_at,
            ended_at: started_at + 1,
            end_reason: EndReason::Completed,
            error: None,
            totals: Totals::default(),
            latency_corrected: Percentiles::default(),
            latency_raw: Percentiles::default(),
            ttfb: Percentiles::default(),
            duration_ms: 1,
            achieved_rps: 0.0,
            bytes: 0,
            capped: false,
            warnings: vec![],
            series: vec![SecondPoint { t_s: 1, rps: 1.0, ok: 1, failed: 0, bytes: 0, p50: 0, p95: 0, p99: 0, raw_p50: 0, raw_p95: 0, raw_p99: 0, vus: 1, iterations: 1 }],
            outcomes: OutcomeCounts::default(),
            endpoints: vec![],
            scenarios: vec![],
            verdict: vec![],
            aborted_by: None,
            env: RunEnv::default(),
            samples: SamplesInfo::default(),
            legacy: false,
        }
    }

    #[test]
    fn tests_roundtrip_sorted_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let s = Storage::open(dir.path()).unwrap();
        s.save_test(&cfg("a", 1)).unwrap();
        s.save_test(&cfg("b", 2)).unwrap();
        let ids: Vec<_> = s.list_tests().unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["b", "a"]);
        s.delete_test("a").unwrap();
        assert_eq!(s.list_tests().unwrap().len(), 1);
        assert!(matches!(s.get_test("a"), Err(StorageError::NotFound(_))));
    }

    #[test]
    fn rejects_path_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let s = Storage::open(dir.path()).unwrap();
        assert!(matches!(s.save_test(&cfg("../evil", 1)), Err(StorageError::BadId(_))));
        assert!(matches!(s.get_run("../../etc/passwd"), Err(StorageError::BadId(_))));
    }

    #[test]
    fn runs_are_pruned_and_index_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        {
            let s = Storage::open(dir.path()).unwrap();
            for i in 0..5 {
                s.save_run(&run(&format!("r{i}"), i), 3).unwrap();
            }
            let ids: Vec<_> = s.list_runs().into_iter().map(|r| r.run_id).collect();
            assert_eq!(ids, ["r4", "r3", "r2"]);
            assert!(s.list_runs()[0].series.is_empty(), "index has no series");
            assert_eq!(s.get_run("r4").unwrap().series.len(), 1);
            assert!(s.get_run("r0").is_err(), "pruned");
            s.delete_run("r3").unwrap();
        }
        let s = Storage::open(dir.path()).unwrap();
        assert_eq!(s.list_runs().len(), 2);
        // Index is a cache: deleting it rebuilds from the run files.
        fs::remove_file(dir.path().join("runs/index.json")).unwrap();
        let s = Storage::open(dir.path()).unwrap();
        let ids: Vec<_> = s.list_runs().into_iter().map(|r| r.run_id).collect();
        assert_eq!(ids, ["r4", "r2"]);
    }

    #[test]
    fn v1_test_files_still_load() {
        let dir = tempfile::tempdir().unwrap();
        let s = Storage::open(dir.path()).unwrap();
        let v1 = r#"{"id":"old","name":"Old","created_at":1,"updated_at":2,
          "request":{"method":"GET","url":"http://localhost/","headers":[],"body":null,"bearer":null},
          "load":{"concurrency":5,"stop":{"kind":"duration","secs":10},"rps_cap":null,"ramp_up_secs":null,"timeout_ms":1000,
                  "success_range":{"min":200,"max":399},"follow_redirects":true,"allow_invalid_certs":false}}"#;
        fs::write(dir.path().join("tests/old.json"), v1).unwrap();
        let t = s.get_test("old").unwrap();
        assert_eq!(t.scenarios[0].executor, Executor::Vus { vus: 5, duration_secs: 10 });
        assert_eq!(s.list_tests().unwrap().len(), 1);
    }

    #[test]
    fn assets_are_copied_pruned_and_removed_with_the_test() {
        let dir = tempfile::tempdir().unwrap();
        let s = Storage::open(dir.path()).unwrap();
        let src = dir.path().join("users list.csv");
        fs::write(&src, "a\n1\n").unwrap();
        let (name, size) = s.import_asset("t1", &src).unwrap();
        assert!(name.ends_with("-users_list.csv") && size == 4);
        assert_eq!(s.read_asset("t1", &name).unwrap(), b"a\n1\n");
        assert!(s.read_asset("t1", "../x").is_err());
        let (other, _) = s.import_asset("t1", &src).unwrap();
        let mut c = cfg("t1", 1);
        c.data.push(DataFile {
            id: "d".into(), name: "users".into(), file: name.clone(), original_name: "users list.csv".into(), format: DataFormat::Csv,
            has_header: true, columns: vec!["a".into()], secret_columns: vec![], rows: 1, distribution: Distribution::Sequential, on_exhausted: OnExhausted::Wrap,
        });
        s.save_test(&c).unwrap();
        assert!(s.read_asset("t1", &other).is_ok(), "fresh files survive a save");
        s.prune_assets(&c, std::time::Duration::ZERO);
        assert!(s.read_asset("t1", &name).is_ok());
        assert!(s.read_asset("t1", &other).is_err(), "unreferenced files are pruned");
        s.copy_assets("t1", "t2").unwrap();
        assert!(s.read_asset("t2", &name).is_ok());
        s.delete_test("t1").unwrap();
        assert!(!dir.path().join("tests/t1").exists());
    }

    #[test]
    fn samples_live_beside_the_run() {
        let dir = tempfile::tempdir().unwrap();
        let s = Storage::open(dir.path()).unwrap();
        s.save_run(&run("r1", 1), 10).unwrap();
        assert!(s.get_samples("r1").unwrap().is_empty());
        s.save_samples("r1", &[]).unwrap();
        assert!(dir.path().join("runs/r1.samples.json").exists());
        assert!(s.get_run("r1").unwrap().legacy, "no endpoints: shown as a legacy run");
        s.delete_run("r1").unwrap();
        assert!(!dir.path().join("runs/r1.samples.json").exists());
        let s = Storage::open(dir.path()).unwrap();
        assert!(s.list_runs().is_empty());
    }

    #[test]
    fn settings_default_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let s = Storage::open(dir.path()).unwrap();
        assert_eq!(s.load_settings(), Settings::default());
        let custom = Settings { history_limit: 5, ..Settings::default() };
        s.save_settings(&custom).unwrap();
        assert_eq!(s.load_settings(), custom);
    }
}
