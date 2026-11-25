//! `gp-train` command line.
//!
//! ```text
//! gp-train train --dataset <dir> --config <train-config.json> --out <model-dir> [--seed N]
//! gp-train eval  --dataset <dir> --model <model-dir> --split test --out <file.json>
//! ```

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use gp_train::dataset::Split;
use gp_train::package::PackageOpts;
use gp_train::{eval, run_train, TrainArgs};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "gp-train", version, about = "Offline trainer of Gran-Prix: dataset + TrainConfig -> ModelPackage")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Train a model and write a ModelPackage directory.
    Train {
        /// Dataset directory (manifest.json + train/val/test.jsonl).
        #[arg(long)]
        dataset: PathBuf,
        /// TrainConfig JSON (contract gran-prix.train-config).
        #[arg(long)]
        config: PathBuf,
        /// Output ModelPackage directory.
        #[arg(long)]
        out: PathBuf,
        /// Overrides the seed of the config (0..=4294967295).
        #[arg(long)]
        seed: Option<u64>,
        /// feature-schema.json of the dataset (default: <dataset>/feature-schema.json if present).
        #[arg(long)]
        feature_schema: Option<PathBuf>,
        /// `name` of the model in model.json.
        #[arg(long)]
        name: Option<String>,
        /// `task.name` of the model in model.json.
        #[arg(long)]
        task_name: Option<String>,
        /// Provenance: run id (set by the pipeline runner).
        #[arg(long)]
        run_id: Option<String>,
        /// Provenance: stage id (default "train").
        #[arg(long)]
        stage_id: Option<String>,
        /// Provenance: stage cache key (default: computed from impl, config and dataset id).
        #[arg(long)]
        cache_key: Option<String>,
        /// Provenance: id of the pipeline spec (default: sha256 of the empty string, "no pipeline").
        #[arg(long)]
        pipeline_spec_id: Option<String>,
        /// Provenance: created_at (RFC 3339 UTC). Default: now, or SOURCE_DATE_EPOCH when set.
        #[arg(long)]
        created_at: Option<String>,
    },
    /// Score a split of a dataset with a ModelPackage and write metrics.
    Eval {
        #[arg(long)]
        dataset: PathBuf,
        /// ModelPackage directory.
        #[arg(long)]
        model: PathBuf,
        /// train, val or test.
        #[arg(long, default_value = "test")]
        split: String,
        #[arg(long)]
        out: PathBuf,
        /// Also write the score of every row.
        #[arg(long)]
        with_scores: bool,
    },
}

fn created_at_default() -> Option<String> {
    let secs: u64 = std::env::var("SOURCE_DATE_EPOCH").ok()?.trim().parse().ok()?;
    Some(gp_train::identity::iso8601_utc(secs))
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Train { dataset, config, out, seed, feature_schema, name, task_name, run_id, stage_id, cache_key, pipeline_spec_id, created_at } => {
            let opts = PackageOpts {
                name,
                task_name,
                run_id,
                stage_id,
                cache_key,
                pipeline_spec_id,
                created_at: created_at.or_else(created_at_default),
                duration_ms: 0,
            };
            let args = TrainArgs { dataset, config, out: out.clone(), seed, feature_schema, opts };
            let (summary, outcome) = run_train(&args).context("train failed")?;
            println!("model_id        {}", summary.model_id);
            println!("weights_sha256  {}", summary.weights_sha256);
            println!(
                "epochs          {} run, best {} {}",
                outcome.history.len(),
                outcome.best_epoch,
                if outcome.stopped_early { "(early stop)" } else { "" }
            );
            println!(
                "thresholds      accept {:.4}  escalate {:.4}",
                outcome.thresholds.accept, outcome.thresholds.escalate
            );
            if let Some(m) = &outcome.val_metrics {
                println!("val             F1 {:.4}  P {:.4}  R {:.4}  (n {})", m.f1, m.precision, m.recall, m.n);
            }
            println!("package         {}", out.display());
        }
        Command::Eval { dataset, model, split, out, with_scores } => {
            let split = Split::parse(&split)?;
            let report = eval::evaluate(&dataset, &model, split, with_scores).context("eval failed")?;
            let mut text = serde_json::to_string_pretty(&report)?;
            text.push('\n');
            std::fs::write(&out, text).with_context(|| format!("writing {}", out.display()))?;
            println!(
                "{}: F1 {:.4}  P {:.4}  R {:.4}  (n {}) -> {}",
                split.name(),
                report["overall"]["f1"].as_f64().unwrap_or(0.0),
                report["overall"]["precision"].as_f64().unwrap_or(0.0),
                report["overall"]["recall"].as_f64().unwrap_or(0.0),
                report["overall"]["n"].as_u64().unwrap_or(0),
                out.display()
            );
        }
    }
    Ok(())
}
