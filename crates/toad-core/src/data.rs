//! Data files: CSV / JSON parsing, previews, and the feeders that hand rows to virtual users.

use crate::spec::{DataFile, DataFormat, Distribution, OnExhausted};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Largest data file Toad loads.
pub const MAX_DATA_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Table {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct DataPreview {
    pub format: DataFormat,
    pub has_header: bool,
    /// The delimiter used (CSV), as text.
    pub delimiter: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub row_count: u64,
    pub warnings: Vec<String>,
}

fn decode(bytes: &[u8]) -> Result<&str, String> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    std::str::from_utf8(bytes).map_err(|e| format!("the file isn't UTF-8 text (byte {})", e.valid_up_to()))
}

fn detect_delimiter(text: &str) -> u8 {
    let first = text.lines().next().unwrap_or("");
    b",;\t|".iter().copied().max_by_key(|d| first.bytes().filter(|b| b == d).count()).unwrap_or(b',')
}

/// RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes, CRLF.
pub fn parse_csv_records(text: &str, delim: u8) -> Result<Vec<Vec<String>>, String> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.char_indices().peekable();
    let mut line = 1;
    let d = delim as char;
    let mut any = false;
    while let Some((_, c)) = chars.next() {
        any = true;
        if quoted {
            if c == '"' {
                if chars.peek().map(|(_, n)| *n) == Some('"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                if c == '\n' {
                    line += 1;
                }
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            c if c == d => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                if !(row.len() == 1 && row[0].is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
                line += 1;
            }
            c => field.push(c),
        }
    }
    if quoted {
        return Err(format!("a quoted field starting before line {line} is never closed"));
    }
    if any && (!field.is_empty() || !row.is_empty()) {
        row.push(field);
        rows.push(row);
    }
    Ok(rows)
}

pub fn parse(bytes: &[u8], format: &DataFormat, has_header: bool) -> Result<(Table, String, Vec<String>), String> {
    let text = decode(bytes)?;
    let mut warnings = Vec::new();
    match format {
        DataFormat::Csv => {
            let delim = detect_delimiter(text);
            let mut records = parse_csv_records(text, delim)?;
            if records.is_empty() {
                return Err("the file has no rows".into());
            }
            let width = records.iter().map(Vec::len).max().unwrap_or(0);
            let columns: Vec<String> = if has_header {
                let head = records.remove(0);
                (0..width)
                    .map(|i| head.get(i).map(|h| h.trim().to_string()).filter(|h| !h.is_empty()).unwrap_or_else(|| format!("col{}", i + 1)))
                    .collect()
            } else {
                (1..=width).map(|i| format!("col{i}")).collect()
            };
            let ragged = records.iter().filter(|r| r.len() != width).count();
            if ragged > 0 {
                warnings.push(format!("{ragged} row(s) have fewer fields than the header; missing fields are empty"));
            }
            for r in &mut records {
                r.resize(width, String::new());
            }
            let delimiter = match delim {
                b'\t' => "tab".to_string(),
                d => (d as char).to_string(),
            };
            Ok((Table { columns, rows: records }, delimiter, warnings))
        }
        DataFormat::Json => {
            let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("not valid JSON: {e}"))?;
            let serde_json::Value::Array(items) = v else {
                return Err("the JSON must be an array of objects (or of arrays)".into());
            };
            let mut columns: Vec<String> = Vec::new();
            for it in &items {
                match it {
                    serde_json::Value::Object(m) => {
                        for k in m.keys() {
                            if !columns.contains(k) {
                                columns.push(k.clone());
                            }
                        }
                    }
                    serde_json::Value::Array(a) => {
                        while columns.len() < a.len() {
                            columns.push(format!("col{}", columns.len() + 1));
                        }
                    }
                    _ => return Err("every item must be an object or an array".into()),
                }
            }
            let rows = items
                .iter()
                .map(|it| match it {
                    serde_json::Value::Object(m) => {
                        columns.iter().map(|c| m.get(c).map(crate::extract::json_text).unwrap_or_default()).collect()
                    }
                    serde_json::Value::Array(a) => {
                        (0..columns.len()).map(|i| a.get(i).map(crate::extract::json_text).unwrap_or_default()).collect()
                    }
                    _ => unreachable!(),
                })
                .collect();
            Ok((Table { columns, rows }, String::new(), warnings))
        }
    }
}

pub fn preview(bytes: &[u8], format: DataFormat, has_header: bool) -> Result<DataPreview, String> {
    let (t, delimiter, warnings) = parse(bytes, &format, has_header)?;
    if t.rows.is_empty() {
        return Err("the file has a header but no rows".into());
    }
    Ok(DataPreview {
        format,
        has_header,
        delimiter,
        columns: t.columns,
        row_count: t.rows.len() as u64,
        rows: t.rows.into_iter().take(20).collect(),
        warnings,
    })
}

/// FNV-1a 64, hex. Identifies a data file's contents in run metadata.
pub fn fingerprint(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exhausted {
    StopVu,
    StopRun,
}

/// Hands rows to virtual users according to the file's distribution.
#[derive(Debug)]
pub struct Feeder {
    pub spec: DataFile,
    pub table: Arc<Table>,
    cursor: AtomicU64,
    pub hash: String,
}

impl Feeder {
    pub fn new(spec: DataFile, table: Table, hash: String) -> Self {
        Feeder { spec, table: Arc::new(table), cursor: AtomicU64::new(0), hash }
    }

    pub fn len(&self) -> usize {
        self.table.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.table.rows.is_empty()
    }

    fn exhausted(&self, n: u64) -> Result<usize, Exhausted> {
        match self.spec.on_exhausted {
            OnExhausted::Wrap => Ok((n % self.len() as u64) as usize),
            OnExhausted::StopVu => Err(Exhausted::StopVu),
            OnExhausted::StopRun => Err(Exhausted::StopRun),
        }
    }

    /// Row for a new iteration (sequential / random). `UniquePerVu` rows come from [`Self::row_for_vu`].
    pub fn next_row(&self, rng: &mut fastrand::Rng) -> Result<usize, Exhausted> {
        if self.is_empty() {
            return Err(Exhausted::StopRun);
        }
        match self.spec.distribution {
            Distribution::Random => Ok(rng.usize(..self.len())),
            Distribution::Sequential | Distribution::UniquePerVu => {
                let n = self.cursor.fetch_add(1, Ordering::Relaxed);
                if (n as usize) < self.len() {
                    Ok(n as usize)
                } else {
                    self.exhausted(n)
                }
            }
        }
    }

    /// The row a virtual user keeps for its whole life (`UniquePerVu`).
    pub fn row_for_vu(&self, vu: u32) -> Result<usize, Exhausted> {
        if self.is_empty() {
            return Err(Exhausted::StopRun);
        }
        if (vu as usize) < self.len() {
            Ok(vu as usize)
        } else {
            self.exhausted(u64::from(vu))
        }
    }

    /// (template name, value) pairs for a row: `name.column`.
    pub fn cells(&self, row: usize) -> impl Iterator<Item = (String, &str)> + '_ {
        let name = self.spec.name.trim();
        self.table.columns.iter().zip(&self.table.rows[row]).map(move |(c, v)| (format!("{name}.{c}"), v.as_str()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_quoting_and_detection() {
        let text = "\u{feff}email;name;note\r\na@x;\"Lovelace, Ada\";\"line\nbreak\"\r\nb@x;Turing;\"say \"\"hi\"\"\"\r\n\r\n";
        let (t, delim, warnings) = parse(text.as_bytes(), &DataFormat::Csv, true).unwrap();
        assert_eq!(delim, ";");
        assert_eq!(t.columns, ["email", "name", "note"]);
        assert_eq!(t.rows, [vec!["a@x", "Lovelace, Ada", "line\nbreak"], vec!["b@x", "Turing", "say \"hi\""]]);
        assert!(warnings.is_empty());
        let (t, _, w) = parse(b"a,b\n1\n", &DataFormat::Csv, true).unwrap();
        assert_eq!(t.rows, [vec!["1", ""]]);
        assert_eq!(w.len(), 1);
        assert!(parse(b"a,\"b\n", &DataFormat::Csv, false).is_err());
        let (t, _, _) = parse(b"1,2\n3,4", &DataFormat::Csv, false).unwrap();
        assert_eq!(t.columns, ["col1", "col2"]);
        assert_eq!(t.rows.len(), 2);
    }

    #[test]
    fn json_tables() {
        let (t, _, _) = parse(br#"[{"id":1,"name":"a"},{"id":2,"extra":true}]"#, &DataFormat::Json, true).unwrap();
        assert_eq!(t.columns, ["id", "name", "extra"]);
        assert_eq!(t.rows[1], ["2", "", "true"]);
        assert!(parse(br#"{"a":1}"#, &DataFormat::Json, true).is_err());
    }

    fn feeder(distribution: Distribution, on_exhausted: OnExhausted, rows: usize) -> Feeder {
        let spec = DataFile {
            id: "d".into(), name: "users".into(), file: "f".into(), original_name: "u.csv".into(), format: DataFormat::Csv,
            has_header: true, columns: vec!["email".into()], secret_columns: vec![], rows: rows as u64, distribution, on_exhausted,
        };
        let table = Table { columns: vec!["email".into()], rows: (0..rows).map(|i| vec![format!("u{i}")]).collect() };
        Feeder::new(spec, table, String::new())
    }

    #[test]
    fn feeders() {
        let mut rng = fastrand::Rng::with_seed(3);
        let f = feeder(Distribution::Sequential, OnExhausted::Wrap, 2);
        let rows: Vec<_> = (0..5).map(|_| f.next_row(&mut rng).unwrap()).collect();
        assert_eq!(rows, [0, 1, 0, 1, 0]);
        let f = feeder(Distribution::Sequential, OnExhausted::StopRun, 1);
        assert_eq!(f.next_row(&mut rng), Ok(0));
        assert_eq!(f.next_row(&mut rng), Err(Exhausted::StopRun));
        let f = feeder(Distribution::UniquePerVu, OnExhausted::StopVu, 2);
        assert_eq!(f.row_for_vu(1), Ok(1));
        assert_eq!(f.row_for_vu(2), Err(Exhausted::StopVu));
        let cells: Vec<_> = f.cells(1).collect();
        assert_eq!(cells, [("users.email".to_string(), "u1")]);
        assert_eq!(fingerprint(b"abc"), "e71fa2190541574b");
    }
}
