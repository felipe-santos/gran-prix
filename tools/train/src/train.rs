//! The training procedure: normalization fitted on train, seeded init, seeded shuffle per
//! epoch, mini-batches, Adam, BCE-with-logits (+ `pos_weight`), early stopping with
//! best-weights restore, and threshold selection on validation.

use crate::config::{LrSchedule, ThresholdCfg, TrainConfig};
use crate::dataset::Rows;
use crate::error::Result;
use crate::invalid;
use crate::loss::{sigmoid_f32, WeightedBce};
use crate::metrics::Metrics;
use crate::net::{Net, ParamInfo};
use crate::normalize::{feature_range, Normalizer, ZScore};
use crate::sampling::{epoch_indices, sampling_rng, shuffle};
use crate::threshold::{best_f1_threshold, select, Confusion, Thresholds};
use gran_prix::network_def::NetworkDef;
use gran_prix::optim::{Adam, Optimizer};

#[derive(Debug, Clone)]
pub struct EpochRecord {
    pub epoch: usize,
    pub lr: f64,
    pub train_loss: f64,
    pub val_loss: Option<f64>,
    pub val_f1: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct TrainOutcome {
    pub seed: u64,
    pub net_def: NetworkDef,
    pub weights: Vec<f32>,
    pub layout: Vec<ParamInfo>,
    pub normalizer: Normalizer,
    /// Per-feature `[min, max]` over the training rows.
    pub ood: (Vec<f32>, Vec<f32>),
    pub thresholds: Thresholds,
    pub pos_weight: f32,
    pub history: Vec<EpochRecord>,
    /// Epoch (0-based) whose weights were kept; the last epoch without early stopping.
    pub best_epoch: usize,
    pub stopped_early: bool,
    pub n_train: usize,
    pub n_train_pos: usize,
    /// Validation metrics at `thresholds.accept` (None when there is no validation split).
    pub val_metrics: Option<Metrics>,
}

/// Learning rate of `epoch` (0-based) under the schedule.
pub fn lr_at(cfg: &TrainConfig, epoch: usize) -> f64 {
    let base = cfg.optimizer.lr;
    match &cfg.lr_schedule {
        None | Some(LrSchedule::Constant) => base,
        Some(LrSchedule::Step { every, gamma }) => base * gamma.powi((epoch / every) as i32),
        Some(LrSchedule::Cosine { min_lr }) => {
            let progress = epoch as f64 / cfg.epochs as f64;
            min_lr + 0.5 * (base - min_lr) * (1.0 + (std::f64::consts::PI * progress).cos())
        }
    }
}

fn resolve_pos_weight(cfg: &TrainConfig, rows: &Rows) -> Result<f32> {
    if cfg.data.class_balance.strategy != "pos_weight" {
        return Ok(1.0);
    }
    if let Some(w) = cfg.data.class_balance.pos_weight {
        return Ok(w as f32);
    }
    let pos = rows.n_pos();
    if pos == 0 {
        return Err(invalid!("pos_weight without a value needs positives in the train split"));
    }
    Ok((rows.len() - pos) as f32 / pos as f32)
}

/// Trains on `train` (already filtered by the config's data policy), monitors `val`.
pub fn train(train: &Rows, val: &Rows, cfg: &TrainConfig, seed: u64) -> Result<TrainOutcome> {
    let dim = train.dim;
    let net_def = cfg.network_def(dim)?;
    if train.is_empty() {
        return Err(invalid!("the train split is empty after applying the data policy (min_confidence / allowed_sources)"));
    }
    let needs_val = cfg.early_stopping.is_some() || matches!(cfg.threshold, ThresholdCfg::MaxF1OnVal);
    if needs_val && val.is_empty() {
        return Err(invalid!("early stopping and max_f1_on_val need a non-empty validation split (it is empty after filtering)"));
    }

    let normalizer = match cfg.normalization.kind.as_str() {
        "zscore" => Normalizer::ZScore(ZScore::fit(train)?),
        _ => Normalizer::None,
    };
    let ood = feature_range(train)?;
    let xt = normalizer.apply_matrix(&train.x, dim);
    let xv = normalizer.apply_matrix(&val.x, dim);

    let pos_weight = resolve_pos_weight(cfg, train)?;
    let loss = WeightedBce::new(pos_weight);
    let mut net = Net::new(&net_def, Some(seed))?;
    if let Some(prefixes) = &cfg.freeze_prefixes {
        net.freeze_prefixes(prefixes)?;
    }
    let mut opt = Adam::new(cfg.optimizer.lr as f32);
    let mut rng = sampling_rng(seed);

    let mut history = Vec::new();
    let mut best: Option<(f64, usize, Vec<f32>)> = None;
    let mut bad_epochs = 0usize;
    let mut stopped_early = false;

    for epoch in 0..cfg.epochs {
        let lr = lr_at(cfg, epoch);
        opt.set_lr(lr as f32);
        let mut idx = epoch_indices(&train.y, &cfg.data.class_balance, &mut rng);
        shuffle(&mut idx, &mut rng);
        let mut total = 0f64;
        for batch in idx.chunks(cfg.batch_size) {
            total += f64::from(net.train_batch(&xt, &train.y, batch, &loss, &mut opt)?);
        }
        let train_loss = total / idx.len().max(1) as f64;
        if !train_loss.is_finite() {
            return Err(invalid!("training diverged at epoch {epoch}: non-finite loss (lower optimizer.lr)"));
        }

        let (mut val_loss, mut val_f1) = (None, None);
        if !val.is_empty() {
            let logits = net.logits(&xv, val.len())?;
            let scores: Vec<f32> = logits.iter().map(|z| sigmoid_f32(*z)).collect();
            val_loss = Some(f64::from(loss.mean_loss(&logits, &val.y)));
            val_f1 = Some(match &cfg.threshold {
                ThresholdCfg::Fixed { value } => Confusion::at(&scores, &val.y, *value as f32).f1(),
                ThresholdCfg::MaxF1OnVal => best_f1_threshold(&scores, &val.y).map_or(0.0, |(_, f1)| f1),
            });
        }
        history.push(EpochRecord { epoch, lr, train_loss, val_loss, val_f1 });

        match &cfg.early_stopping {
            None => best = Some((0.0, epoch, net.weights()?)),
            Some(es) => {
                let (value, lower_is_better) = match es.metric.as_str() {
                    "val_f1" => (val_f1.unwrap_or(0.0), false),
                    _ => (val_loss.unwrap_or(f64::INFINITY), true),
                };
                let improved = match &best {
                    None => true,
                    Some((b, _, _)) if lower_is_better => value < *b - es.min_delta,
                    Some((b, _, _)) => value > *b + es.min_delta,
                };
                if improved {
                    best = Some((value, epoch, net.weights()?));
                    bad_epochs = 0;
                } else {
                    bad_epochs += 1;
                    if bad_epochs >= es.patience {
                        stopped_early = true;
                        break;
                    }
                }
            }
        }
    }

    let (best_epoch, weights) = match best {
        Some((_, e, w)) => (e, w),
        None => return Err(invalid!("no epoch was run")),
    };
    net.load_weights(&weights)?;

    let (val_logits, val_scores): (Vec<f32>, Vec<f32>) = if val.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        let logits = net.logits(&xv, val.len())?;
        let scores = logits.iter().map(|z| sigmoid_f32(*z)).collect();
        (logits, scores)
    };
    let thresholds = select(&cfg.threshold, &val_scores, &val.y)?;
    let val_metrics = (!val.is_empty()).then(|| Metrics::compute(&val_logits, &val.y, thresholds.accept));

    Ok(TrainOutcome {
        seed,
        layout: net.param_layout(),
        net_def,
        weights,
        normalizer,
        ood,
        thresholds,
        pos_weight,
        history,
        best_epoch,
        stopped_early,
        n_train: train.len(),
        n_train_pos: train.n_pos(),
        val_metrics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(extra: &str) -> TrainConfig {
        let text = format!(
            r#"{{"format":"gran-prix.train-config","format_version":"1.0.0","seed":1,
            "network":{{"kind":"mlp","hidden":[8],"activation":"relu","input_dim":"auto"}},
            "loss":"bce_logits","optimizer":{{"kind":"adam","lr":0.05}},
            "epochs":40,"batch_size":16,
            "data":{{"min_confidence":0,"allowed_sources":["human"],"class_balance":{{"strategy":"none"}}}},
            "normalization":{{"kind":"zscore","fit_on":"train"}},
            "threshold":{{"strategy":"max_f1_on_val"}},
            "runtime":{{"engine":"gp-train"}}{extra}}}"#
        );
        TrainConfig::parse(&text).expect("valid test config").0
    }

    /// Two Gaussian-ish blobs along the first two features; `pos_every` controls imbalance.
    fn blobs(n: usize, pos_every: usize, seed: u64) -> Rows {
        let mut s = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let mut next = move || {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((s >> 40) as f32 / (1u64 << 24) as f32) - 0.5
        };
        let mut r = Rows { dim: 3, ..Rows::default() };
        for i in 0..n {
            let y = u8::from(i % pos_every == 0);
            let c = if y == 1 { 1.0 } else { -1.0 };
            r.x.extend_from_slice(&[c + next() * 1.2, c * 0.5 + next() * 1.2, 100.0 + next() * 50.0]);
            r.y.push(y);
            r.conf.push(1.0);
            r.source.push("human".into());
            r.group.push(format!("g{}", i % 7));
            r.unit.push(i as u64);
        }
        r
    }

    #[test]
    fn learns_a_separable_problem_and_picks_a_good_threshold() {
        let (tr, va) = (blobs(400, 3, 1), blobs(150, 3, 2));
        let out = train(&tr, &va, &cfg(""), 11).expect("trains");
        let m = out.val_metrics.expect("val metrics");
        assert!(m.f1 > 0.9, "val F1 {}", m.f1);
        assert!(out.history.first().map(|h| h.train_loss) > out.history.last().map(|h| h.train_loss));
        assert!(out.thresholds.accept > 0.0 && out.thresholds.accept < 1.0);
        assert!(out.thresholds.escalate <= out.thresholds.accept);
        assert_eq!(out.weights.len(), out.layout.iter().map(|p| p.length).sum::<usize>());
    }

    #[test]
    fn same_seed_same_weights_and_a_different_seed_differs() {
        let (tr, va) = (blobs(200, 3, 1), blobs(80, 3, 2));
        let a = train(&tr, &va, &cfg(""), 5).expect("trains");
        let b = train(&tr, &va, &cfg(""), 5).expect("trains");
        let c = train(&tr, &va, &cfg(""), 6).expect("trains");
        assert_eq!(a.weights, b.weights);
        assert_eq!(a.thresholds, b.thresholds);
        assert_ne!(a.weights, c.weights);
    }

    #[test]
    fn early_stopping_halts_and_keeps_the_best_epoch() {
        let (tr, va) = (blobs(200, 3, 1), blobs(80, 3, 2));
        let es = r#","early_stopping":{"metric":"val_loss","patience":2,"min_delta":0.5}"#;
        let out = train(&tr, &va, &cfg(es), 5).expect("trains");
        assert!(out.stopped_early, "min_delta 0.5 cannot be beaten for long");
        assert!(out.history.len() < 40);
        assert!(out.best_epoch + 1 < out.history.len(), "patience epochs were run after the best one");
        // Restoring the best weights: the validation metrics come from them, not from the last epoch.
        let best = out.history[out.best_epoch].val_loss.expect("val loss");
        assert!(best.is_finite());
    }

    #[test]
    fn pos_weight_raises_recall_on_imbalanced_data() {
        let (tr, va) = (blobs(600, 10, 1), blobs(200, 10, 2));
        let mut plain = cfg("");
        plain.threshold = ThresholdCfg::Fixed { value: 0.5 };
        plain.epochs = 6;
        let mut weighted = plain.clone();
        weighted.data.class_balance.strategy = "pos_weight".into();
        weighted.data.class_balance.pos_weight = Some(9.0);
        let recall = |c: &TrainConfig| train(&tr, &va, c, 3).expect("trains").val_metrics.expect("val").recall;
        let (r_plain, r_weighted) = (recall(&plain), recall(&weighted));
        assert!(r_weighted >= r_plain, "recall {r_plain} -> {r_weighted}");
        let out = train(&tr, &va, &weighted, 3).expect("trains");
        assert_eq!(out.pos_weight, 9.0);
    }

    #[test]
    fn auto_pos_weight_is_the_negative_to_positive_ratio() {
        let tr = blobs(100, 4, 1); // 25 positives, 75 negatives
        let mut c = cfg("");
        c.data.class_balance.strategy = "pos_weight".into();
        assert_eq!(resolve_pos_weight(&c, &tr).expect("resolves"), 3.0);
    }

    #[test]
    fn resampling_strategies_train() {
        let (tr, va) = (blobs(300, 8, 1), blobs(100, 8, 2));
        for s in ["oversample_pos", "undersample_neg"] {
            let mut c = cfg("");
            c.epochs = 8;
            c.data.class_balance.strategy = s.into();
            let out = train(&tr, &va, &c, 2).expect("trains");
            assert!(out.val_metrics.expect("val").recall > 0.5, "{s}");
        }
    }

    #[test]
    fn schedules_follow_their_formulas() {
        let mut c = cfg("");
        c.optimizer.lr = 0.1;
        c.epochs = 10;
        c.lr_schedule = Some(LrSchedule::Step { every: 3, gamma: 0.5 });
        assert_eq!((lr_at(&c, 0), lr_at(&c, 2), lr_at(&c, 3), lr_at(&c, 7)), (0.1, 0.1, 0.05, 0.025));
        c.lr_schedule = Some(LrSchedule::Cosine { min_lr: 0.01 });
        assert!((lr_at(&c, 0) - 0.1).abs() < 1e-12);
        assert!((lr_at(&c, 5) - 0.055).abs() < 1e-12);
        assert!(lr_at(&c, 9) > 0.01);
    }

    #[test]
    fn refuses_an_empty_validation_split_when_it_is_needed() {
        let tr = blobs(50, 3, 1);
        let empty = Rows { dim: 3, ..Rows::default() };
        assert!(train(&tr, &empty, &cfg(""), 1).is_err());
        let mut c = cfg("");
        c.threshold = ThresholdCfg::Fixed { value: 0.5 };
        c.epochs = 2;
        let out = train(&tr, &empty, &c, 1).expect("fixed threshold works without validation");
        assert!(out.val_metrics.is_none());
        assert_eq!(out.thresholds.accept, 0.5);
    }
}
