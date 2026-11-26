//! gp-train: offline trainer of Gran-Prix (ADR-007).
//!
//! `train`: dataset directory + TrainConfig -> ModelPackage directory (ADR-003).
//! `eval`: dataset split + ModelPackage -> metrics.
//!
//! Determinism: the same dataset, config and seed give a byte-identical `weights.f32le`
//! (seeded ChaCha8 initialization from the core, seeded shuffle, single-threaded math).

pub mod canonical;
pub mod config;
pub mod dataset;
pub mod error;
pub mod eval;
pub mod identity;
pub mod load;
pub mod loss;
pub mod metrics;
pub mod net;
pub mod normalize;
pub mod package;
pub mod sampling;
pub mod threshold;
pub mod train;

use crate::config::TrainConfig;
use crate::dataset::{load_split, Manifest, Split};
use crate::error::Result;
use crate::package::{write_package, FeatureInfo, PackageInputs, PackageOpts, PackageSummary};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Inputs of `gp-train train`.
#[derive(Debug, Clone)]
pub struct TrainArgs {
    pub dataset: PathBuf,
    pub config: PathBuf,
    pub out: PathBuf,
    /// Overrides `seed` of the config (recorded in the provenance hashes).
    pub seed: Option<u64>,
    /// `feature-schema.json` of the dataset; defaults to `<dataset>/feature-schema.json`
    /// when present.
    pub feature_schema: Option<PathBuf>,
    pub opts: PackageOpts,
}

/// Runs the whole `train` command and returns the summary of the written package.
pub fn run_train(args: &TrainArgs) -> Result<(PackageSummary, train::TrainOutcome)> {
    let started = Instant::now();
    let (cfg, mut raw) = TrainConfig::load(&args.config)?;
    let seed = args.seed.unwrap_or(cfg.seed);
    if seed > u64::from(u32::MAX) {
        return Err(crate::invalid!("seed {seed} does not fit in 32 bits (the contract and the WASM trainer use u32 seeds)"));
    }
    if let Some(map) = raw.as_object_mut() {
        map.insert("seed".to_string(), serde_json::json!(seed));
    }

    let manifest = Manifest::load(&args.dataset)?;
    if cfg.uses_row_weight() && manifest.row_weight.is_none() {
        return Err(crate::invalid!("sample_weight \"row\" needs row weights, but the dataset manifest declares no row_weight"));
    }
    let keep = |rows: dataset::Rows| rows.filtered(cfg.data.min_confidence, Some(&cfg.data.allowed_sources));
    let train_rows = keep(load_split(&args.dataset, &manifest, Split::Train)?);
    let val_rows = keep(load_split(&args.dataset, &manifest, Split::Val)?);

    let features = match feature_schema_path(args) {
        Some(p) => FeatureInfo::from_schema_file(&p, &manifest)?,
        None => FeatureInfo::anonymous(&manifest),
    };

    let outcome = train::train(&train_rows, &val_rows, &cfg, seed)?;
    let mut opts = args.opts.clone();
    opts.duration_ms.get_or_insert(started.elapsed().as_millis() as u64);
    let inputs = PackageInputs { outcome: &outcome, train: &train_rows, val: &val_rows, manifest: &manifest, features: &features, config_raw: &raw };
    let summary = write_package(&args.out, &inputs, &opts)?;
    Ok((summary, outcome))
}

fn feature_schema_path(args: &TrainArgs) -> Option<PathBuf> {
    match &args.feature_schema {
        Some(p) => Some(p.clone()),
        None => {
            let default: &Path = &args.dataset;
            let p = default.join("feature-schema.json");
            p.exists().then_some(p)
        }
    }
}
