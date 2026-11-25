//! Dataset directory (`manifest.json` + `train|val|test.jsonl`, contracts `dataset-manifest`
//! and `dataset-row`). The manifest is validated against the rows before any training.

use crate::canonical::sha256_id;
use crate::error::{parse_json, read_bytes, read_text, Result};
use crate::invalid;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Split {
    Train,
    Val,
    Test,
}

impl Split {
    pub fn name(self) -> &'static str {
        match self {
            Split::Train => "train",
            Split::Val => "val",
            Split::Test => "test",
        }
    }

    pub fn parse(s: &str) -> Result<Split> {
        match s {
            "train" => Ok(Split::Train),
            "val" => Ok(Split::Val),
            "test" => Ok(Split::Test),
            other => Err(invalid!("unknown split \"{other}\" (train, val or test)")),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct LabelSpace {
    pub kind: String,
    pub classes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Filters {
    pub min_confidence: f64,
    pub allowed_sources: Vec<String>,
    #[serde(default)]
    pub test_allowed_sources: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub sha256: String,
    pub rows: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Files {
    pub train: FileEntry,
    pub val: FileEntry,
    pub test: FileEntry,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GroupEntry {
    pub group_id: String,
    pub stratum: String,
}

/// The parts of `dataset-manifest` that gp-train reads.
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub format: String,
    pub format_version: String,
    pub dataset_id: String,
    pub feature_schema_id: String,
    pub dim: usize,
    /// v1.1: when present, every row carries `w` (the unit's own-text length in characters).
    #[serde(default)]
    pub row_weight: Option<String>,
    pub label_space: LabelSpace,
    pub filters: Filters,
    pub files: Files,
    #[serde(default)]
    pub groups: Vec<GroupEntry>,
}

impl Manifest {
    pub fn file(&self, split: Split) -> &FileEntry {
        match split {
            Split::Train => &self.files.train,
            Split::Val => &self.files.val,
            Split::Test => &self.files.test,
        }
    }

    pub fn stratum_of(&self) -> BTreeMap<&str, &str> {
        self.groups.iter().map(|g| (g.group_id.as_str(), g.stratum.as_str())).collect()
    }

    pub fn load(dir: &Path) -> Result<Manifest> {
        let text = read_text(&dir.join("manifest.json"))?;
        let m: Manifest = parse_json(&text, "manifest.json")?;
        if m.format != "gran-prix.dataset-manifest" {
            return Err(invalid!("manifest format is \"{}\", expected \"gran-prix.dataset-manifest\"", m.format));
        }
        if m.format_version.split('.').next() != Some("1") {
            return Err(invalid!("unsupported dataset-manifest format_version {}", m.format_version));
        }
        if m.label_space.kind != "binary" || m.label_space.classes != ["drop", "keep"] {
            return Err(invalid!(
                "label_space {:?} {:?} is not supported: gp-train v0 reads the binary space [\"drop\", \"keep\"]",
                m.label_space.kind,
                m.label_space.classes
            ));
        }
        if m.dim == 0 {
            return Err(invalid!("manifest dim must be >= 1"));
        }
        if let Some(rw) = &m.row_weight {
            if rw != "own_text_chars" {
                return Err(invalid!("manifest row_weight \"{rw}\" is not supported (only \"own_text_chars\")"));
            }
        }
        Ok(m)
    }
}

/// One split in memory, row-major.
#[derive(Debug, Clone, Default)]
pub struct Rows {
    pub dim: usize,
    pub x: Vec<f32>,
    pub y: Vec<u8>,
    pub conf: Vec<f64>,
    pub source: Vec<String>,
    pub group: Vec<String>,
    pub unit: Vec<u64>,
    /// Per-row weight `w` of the dataset (own-text characters). EMPTY when the dataset has no
    /// row weights (manifest without `row_weight`); otherwise one value per row.
    pub w: Vec<f32>,
}

impl Rows {
    /// Whether every row carries a weight (`sample_weight: "row"` needs it).
    pub fn has_weights(&self) -> bool {
        self.w.len() == self.y.len()
    }

    pub fn len(&self) -> usize {
        self.y.len()
    }

    pub fn is_empty(&self) -> bool {
        self.y.is_empty()
    }

    pub fn row(&self, i: usize) -> &[f32] {
        &self.x[i * self.dim..(i + 1) * self.dim]
    }

    pub fn n_pos(&self) -> usize {
        self.y.iter().filter(|y| **y == 1).count()
    }

    /// Keeps the rows whose confidence is at least `min_confidence` and whose label source is
    /// in `allowed` (`None` = any source). Order is preserved.
    pub fn filtered(&self, min_confidence: f64, allowed: Option<&[String]>) -> Rows {
        let mut out = Rows { dim: self.dim, ..Rows::default() };
        let weighted = !self.w.is_empty() && self.has_weights();
        for i in 0..self.len() {
            let ok_source = allowed.is_none_or(|a| a.iter().any(|s| *s == self.source[i]));
            if self.conf[i] >= min_confidence && ok_source {
                out.x.extend_from_slice(self.row(i));
                out.y.push(self.y[i]);
                out.conf.push(self.conf[i]);
                out.source.push(self.source[i].clone());
                out.group.push(self.group[i].clone());
                out.unit.push(self.unit[i]);
                if weighted {
                    out.w.push(self.w[i]);
                }
            }
        }
        out
    }
}

#[derive(Deserialize)]
struct RawRow {
    g: String,
    u: u64,
    x: Vec<f64>,
    y: u64,
    c: f64,
    s: String,
    #[serde(default)]
    w: Option<u64>,
}

/// Loads one split: checks the file hash and row count against the manifest, then every
/// row against the manifest (`x.len() == dim`, finite, `y in {0, 1}`, `c in [0, 1]`, and `w`
/// present when the manifest declares `row_weight`). Without `row_weight`, `w` is ignored.
pub fn load_split(dir: &Path, manifest: &Manifest, split: Split) -> Result<Rows> {
    let entry = manifest.file(split);
    if entry.path.contains("..") || entry.path.starts_with('/') {
        return Err(invalid!("{}: unsafe path \"{}\" in the manifest", split.name(), entry.path));
    }
    let path = dir.join(&entry.path);
    let bytes = read_bytes(&path)?;
    let actual = sha256_id(&bytes);
    if actual != entry.sha256 {
        return Err(invalid!("{}: sha256 {actual} does not match the manifest ({})", path.display(), entry.sha256));
    }
    let text = String::from_utf8(bytes).map_err(|_| invalid!("{}: not valid UTF-8", path.display()))?;
    let mut rows = Rows { dim: manifest.dim, ..Rows::default() };
    for (n, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let at = format!("{} line {}", entry.path, n + 1);
        let r: RawRow = parse_json(line, &at)?;
        if r.x.len() != manifest.dim {
            return Err(invalid!("{at}: x has {} values, the manifest dim is {}", r.x.len(), manifest.dim));
        }
        if r.y > 1 {
            return Err(invalid!("{at}: y = {} is not in the binary label space", r.y));
        }
        if !(0.0..=1.0).contains(&r.c) {
            return Err(invalid!("{at}: confidence {} is outside [0, 1]", r.c));
        }
        for v in &r.x {
            let f = *v as f32;
            if !f.is_finite() {
                return Err(invalid!("{at}: feature value {v} is not a finite float32"));
            }
            rows.x.push(f);
        }
        rows.y.push(r.y as u8);
        rows.conf.push(r.c);
        rows.source.push(r.s);
        rows.group.push(r.g);
        rows.unit.push(r.u);
        if manifest.row_weight.is_some() {
            let w = r.w.ok_or_else(|| invalid!("{at}: the manifest declares row_weight but the row has no w"))?;
            rows.w.push(w as f32);
        }
    }
    if rows.len() != entry.rows {
        return Err(invalid!("{}: {} rows but the manifest declares {}", entry.path, rows.len(), entry.rows));
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Rows {
        Rows {
            dim: 2,
            x: vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
            y: vec![1, 0, 1],
            conf: vec![0.9, 0.4, 0.6],
            source: vec!["human".into(), "llm".into(), "heuristic".into()],
            group: vec!["a".into(), "a".into(), "b".into()],
            unit: vec![0, 1, 2],
            w: vec![10.0, 20.0, 30.0],
        }
    }

    #[test]
    fn filter_applies_confidence_and_source_in_order() {
        let r = rows();
        let f = r.filtered(0.5, Some(&["human".to_string(), "heuristic".to_string()]));
        assert_eq!(f.len(), 2);
        assert_eq!(f.row(1), &[5.0, 6.0]);
        assert_eq!(f.unit, vec![0, 2]);
        assert_eq!(f.w, vec![10.0, 30.0], "weights follow their rows");
        assert!(f.has_weights());
        assert!(!Rows { w: Vec::new(), ..rows() }.has_weights());
        assert_eq!(r.filtered(0.0, None).len(), 3);
        assert_eq!(r.filtered(0.5, None).len(), 2);
        assert_eq!(r.n_pos(), 2);
    }

    #[test]
    fn split_names_round_trip() {
        for s in [Split::Train, Split::Val, Split::Test] {
            assert_eq!(Split::parse(s.name()).expect("known"), s);
        }
        assert!(Split::parse("dev").is_err());
    }
}
