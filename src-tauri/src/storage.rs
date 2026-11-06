//! JSON persistence in the app data dir:
//!   tests/{id}.json        saved test configs
//!   runs/{run_id}.json     one file per run (summary + per-second series)
//!   runs/index.json        cache of run summaries without series (rebuildable)
//!   settings.json

use serde::{de::DeserializeOwned, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use toad_core::{RunSummary, Settings, TestConfig};

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
        write_json(&self.tests_dir().join(format!("{}.json", checked(&cfg.id)?)), cfg)
    }

    pub fn delete_test(&self, id: &str) -> Result<()> {
        let path = self.tests_dir().join(format!("{}.json", checked(id)?));
        match fs::remove_file(path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
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
        TestConfig {
            id: id.into(),
            name: format!("test {id}"),
            request: RequestSpec { method: Method::Get, url: "http://localhost".into(), headers: vec![], body: None, bearer: None },
            load: LoadSpec::default(),
            created_at: 0,
            updated_at,
        }
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
            series: vec![SecondPoint { t_s: 1, rps: 1.0, ok: 1, failed: 0, bytes: 0, p50: 0, p95: 0, p99: 0, raw_p50: 0, raw_p95: 0, raw_p99: 0 }],
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
    fn settings_default_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let s = Storage::open(dir.path()).unwrap();
        assert_eq!(s.load_settings(), Settings::default());
        let custom = Settings { history_limit: 5, ..Settings::default() };
        s.save_settings(&custom).unwrap();
        assert_eq!(s.load_settings(), custom);
    }
}
