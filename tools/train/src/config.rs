//! `TrainConfig` (contract `gran-prix.train-config` v1) as read by gp-train, plus the checks
//! for what gp-train v0 does not implement (those are refused loudly, never ignored).

use crate::error::{parse_json, read_text, Result};
use crate::{canonical, invalid};
use gran_prix::network_def::{ActivationType, LayerDef, NetworkDef};
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct TrainConfig {
    pub format: String,
    pub format_version: String,
    pub seed: u64,
    pub network: NetworkSpec,
    pub loss: String,
    pub optimizer: OptimizerCfg,
    #[serde(default)]
    pub lr_schedule: Option<LrSchedule>,
    /// v1.1: `"none"` (default) or `"row"` (weighted loss, `w` column of the dataset rows).
    #[serde(default)]
    pub sample_weight: Option<String>,
    pub epochs: usize,
    pub batch_size: usize,
    pub data: DataCfg,
    pub normalization: NormalizationCfg,
    #[serde(default)]
    pub early_stopping: Option<EarlyStopping>,
    pub threshold: ThresholdCfg,
    #[serde(default)]
    pub init_from: Option<Value>,
    #[serde(default)]
    pub freeze_prefixes: Option<Vec<String>>,
    pub runtime: RuntimeCfg,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NetworkSpec {
    Def { def: Value },
    Mlp { hidden: Vec<usize>, activation: String, input_dim: Value },
}

#[derive(Debug, Clone, Deserialize)]
pub struct OptimizerCfg {
    pub kind: String,
    pub lr: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LrSchedule {
    Constant,
    Step { every: usize, gamma: f64 },
    Cosine { min_lr: f64 },
}

#[derive(Debug, Clone, Deserialize)]
pub struct DataCfg {
    pub min_confidence: f64,
    pub allowed_sources: Vec<String>,
    pub class_balance: ClassBalance,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClassBalance {
    pub strategy: String,
    #[serde(default)]
    pub target_pos_rate: Option<f64>,
    #[serde(default)]
    pub pos_weight: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NormalizationCfg {
    pub kind: String,
    pub fit_on: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EarlyStopping {
    pub metric: String,
    pub patience: usize,
    pub min_delta: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "strategy", rename_all = "snake_case")]
pub enum ThresholdCfg {
    Fixed { value: f64 },
    MaxF1OnVal,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RuntimeCfg {
    pub engine: String,
}

impl TrainConfig {
    /// Reads a config file. Returns the typed config and the raw document (for hashing).
    pub fn load(path: &Path) -> Result<(TrainConfig, Value)> {
        let text = read_text(path)?;
        Self::parse(&text)
    }

    pub fn parse(text: &str) -> Result<(TrainConfig, Value)> {
        let raw: Value = parse_json(text, "train config")?;
        let cfg: TrainConfig = serde_json::from_value(raw.clone()).map_err(|e| invalid!("train config does not match the contract: {e}"))?;
        cfg.check_supported()?;
        Ok((cfg, raw))
    }

    /// Contract id of the config (`contractId("train-config")`: the document minus
    /// `train_config_id`), used as the `params_sha256` of the provenance.
    pub fn content_id(raw: &Value) -> Result<String> {
        let mut doc = raw.clone();
        if let Some(map) = doc.as_object_mut() {
            map.remove("train_config_id");
        }
        canonical::artifact_id(&doc)
    }

    /// Whether the loss is weighted by the `w` column of the dataset rows (`sample_weight: "row"`).
    pub fn uses_row_weight(&self) -> bool {
        self.sample_weight.as_deref() == Some("row")
    }

    /// Everything gp-train v0 cannot honor is an error here, with the reason.
    fn check_supported(&self) -> Result<()> {
        if self.format != "gran-prix.train-config" {
            return Err(invalid!("config format is \"{}\", expected \"gran-prix.train-config\"", self.format));
        }
        let major = self.format_version.split('.').next().unwrap_or("");
        if major != "1" {
            return Err(invalid!("unsupported train-config format_version {} (this gp-train reads MAJOR 1)", self.format_version));
        }
        if self.runtime.engine != "gp-train" {
            return Err(invalid!("runtime.engine is \"{}\"; gp-train only runs configs with engine \"gp-train\"", self.runtime.engine));
        }
        if self.loss != "bce_logits" {
            return Err(invalid!("loss \"{}\" is not supported yet: gp-train v0 trains binary models (loss \"bce_logits\", one logit)", self.loss));
        }
        if self.optimizer.kind != "adam" {
            return Err(invalid!("optimizer \"{}\" is not supported (only adam)", self.optimizer.kind));
        }
        // `Adam::new` asserts lr > 0 in f32: refuse here what would panic there.
        if !(self.optimizer.lr.is_finite() && (self.optimizer.lr as f32) > 0.0) {
            return Err(invalid!("optimizer.lr must be a positive float32"));
        }
        if !matches!(self.sample_weight.as_deref(), None | Some("none" | "row")) {
            return Err(invalid!("unknown sample_weight \"{}\" (none or row)", self.sample_weight.as_deref().unwrap_or("")));
        }
        if self.epochs == 0 || self.batch_size == 0 {
            return Err(invalid!("epochs and batch_size must be >= 1"));
        }
        if self.normalization.fit_on != "train" {
            return Err(invalid!("normalization.fit_on must be \"train\" (fitting on val/test would leak)"));
        }
        if !matches!(self.normalization.kind.as_str(), "none" | "zscore") {
            return Err(invalid!("unknown normalization kind \"{}\"", self.normalization.kind));
        }
        if self.init_from.is_some() {
            return Err(invalid!("init_from (warm start from another model_id) is not supported by gp-train v0"));
        }
        if let Some(es) = &self.early_stopping {
            if !matches!(es.metric.as_str(), "val_loss" | "val_f1") {
                return Err(invalid!("early_stopping.metric \"{}\" is not supported", es.metric));
            }
            if es.patience == 0 {
                return Err(invalid!("early_stopping.patience must be >= 1"));
            }
        }
        match &self.lr_schedule {
            Some(LrSchedule::Step { every, gamma }) if *every == 0 || !(*gamma > 0.0 && *gamma <= 1.0) => {
                return Err(invalid!("lr_schedule step needs every >= 1 and 0 < gamma <= 1"));
            }
            Some(LrSchedule::Cosine { min_lr }) if !(*min_lr >= 0.0 && *min_lr <= self.optimizer.lr) => {
                return Err(invalid!("lr_schedule cosine needs 0 <= min_lr <= optimizer.lr"));
            }
            _ => {}
        }
        if let ThresholdCfg::Fixed { value } = &self.threshold {
            if !(0.0..=1.0).contains(value) {
                return Err(invalid!("threshold.value must be in [0, 1]"));
            }
        }
        let cb = &self.data.class_balance;
        match cb.strategy.as_str() {
            "none" | "pos_weight" | "oversample_pos" | "undersample_neg" => {}
            other => return Err(invalid!("unknown class_balance.strategy \"{other}\"")),
        }
        if let Some(w) = cb.pos_weight {
            if !(w.is_finite() && w > 0.0) {
                return Err(invalid!("class_balance.pos_weight must be > 0"));
            }
        }
        if let Some(r) = cb.target_pos_rate {
            if !(r > 0.0 && r < 1.0) {
                return Err(invalid!("class_balance.target_pos_rate must be in (0, 1)"));
            }
        }
        Ok(())
    }

    /// Resolves the network of the config for a dataset with `dim` features:
    /// a single-logit feed-forward network (the `bce_logits` contract).
    pub fn network_def(&self, dim: usize) -> Result<NetworkDef> {
        let def = match &self.network {
            NetworkSpec::Mlp { hidden, activation, input_dim } => {
                if hidden.contains(&0) {
                    return Err(invalid!("network.hidden sizes must be >= 1"));
                }
                match input_dim {
                    Value::String(s) if s == "auto" => {}
                    Value::Number(n) if n.as_u64() == Some(dim as u64) => {}
                    other => return Err(invalid!("network.input_dim {other} does not match the dataset dim {dim} (use \"auto\")")),
                }
                let act = match activation.as_str() {
                    "relu" => ActivationType::ReLU,
                    "tanh" => ActivationType::Tanh,
                    "sigmoid" => ActivationType::Sigmoid,
                    other => return Err(invalid!("unknown MLP activation \"{other}\"")),
                };
                NetworkDef::mlp(dim, hidden, 1, act, None)
            }
            NetworkSpec::Def { def } => {
                let text = serde_json::to_string(def).map_err(|e| invalid!("network.def is not serializable: {e}"))?;
                NetworkDef::from_json(&text)?
            }
        };
        check_network(&def, dim)?;
        Ok(def)
    }
}

/// gp-train v0 supports the stateless feed-forward layers whose inference is identical in
/// every runtime (linear, activation, dropout) and a single output logit.
fn check_network(def: &NetworkDef, dim: usize) -> Result<()> {
    if def.input_dim != dim {
        return Err(invalid!("network input_dim {} != dataset dim {dim}", def.input_dim));
    }
    for (i, layer) in def.layers.iter().enumerate() {
        match layer {
            LayerDef::Linear { .. } | LayerDef::Activation { .. } | LayerDef::Dropout { .. } => {}
            LayerDef::Rnn { .. } | LayerDef::Gru { .. } | LayerDef::BatchNorm { .. } => {
                return Err(invalid!(
                    "layers[{i}]: rnn / gru / batchnorm are not supported (state or running statistics are not part of the package)"
                ));
            }
        }
    }
    def.validate()?;
    if def.output_dim() != 1 {
        return Err(invalid!("bce_logits needs a single output unit, the network ends with {}", def.output_dim()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = r#"{
      "format":"gran-prix.train-config","format_version":"1.0.0","seed":7,
      "network":{"kind":"mlp","hidden":[4],"activation":"relu","input_dim":"auto"},
      "loss":"bce_logits","optimizer":{"kind":"adam","lr":0.01},
      "epochs":3,"batch_size":8,
      "data":{"min_confidence":0.5,"allowed_sources":["human"],"class_balance":{"strategy":"none"}},
      "normalization":{"kind":"zscore","fit_on":"train"},
      "threshold":{"strategy":"max_f1_on_val"},
      "runtime":{"engine":"gp-train"}}"#;

    #[test]
    fn parses_a_minimal_config_and_builds_the_mlp() {
        let (cfg, _) = TrainConfig::parse(BASE).expect("valid");
        let def = cfg.network_def(5).expect("network");
        assert_eq!(def.input_dim, 5);
        assert_eq!(def.output_dim(), 1);
        assert_eq!(def.layers.len(), 3);
    }

    #[test]
    fn refuses_what_it_cannot_honor() {
        let cases = [
            (r#""loss":"bce_logits""#, r#""loss":"ce_logits""#, "binary"),
            (r#""engine":"gp-train""#, r#""engine":"wasm-node""#, "engine"),
            (r#""seed":7,"#, r#""seed":7,"init_from":{"model_id":"sha256:00"},"#, "init_from"),
        ];
        for (from, to, needle) in cases.iter() {
            let text = BASE.replace(from, to);
            let err = TrainConfig::parse(&text).expect_err("must be refused").to_string();
            assert!(err.contains(needle), "{err}");
        }
    }

    #[test]
    fn rejects_unsupported_layers_and_wrong_output_width() {
        let rnn = BASE.replace(
            r#"{"kind":"mlp","hidden":[4],"activation":"relu","input_dim":"auto"}"#,
            r#"{"kind":"def","def":{"input_dim":3,"layers":[{"type":"rnn","input_size":3,"hidden_size":2},{"type":"linear","in_features":2,"out_features":1}]}}"#,
        );
        let (cfg, _) = TrainConfig::parse(&rnn).expect("schema-valid");
        assert!(cfg.network_def(3).expect_err("rnn refused").to_string().contains("rnn"));

        let wide = BASE.replace(
            r#"{"kind":"mlp","hidden":[4],"activation":"relu","input_dim":"auto"}"#,
            r#"{"kind":"def","def":{"input_dim":3,"layers":[{"type":"linear","in_features":3,"out_features":2}]}}"#,
        );
        let (cfg, _) = TrainConfig::parse(&wide).expect("schema-valid");
        assert!(cfg.network_def(3).expect_err("two outputs refused").to_string().contains("single output"));
    }

    #[test]
    fn sample_weight_is_none_by_default_and_row_is_opt_in() {
        let (cfg, _) = TrainConfig::parse(BASE).expect("valid");
        assert!(!cfg.uses_row_weight());
        for (text, row) in [("none", false), ("row", true)] {
            let with = BASE.replace(r#""seed":7,"#, &format!(r#""seed":7,"sample_weight":"{text}","#));
            assert_eq!(TrainConfig::parse(&with).expect("valid").0.uses_row_weight(), row, "{text}");
        }
        let bad = BASE.replace(r#""seed":7,"#, r#""seed":7,"sample_weight":"chars","#);
        assert!(TrainConfig::parse(&bad).expect_err("unknown value").to_string().contains("sample_weight"));
    }

    #[test]
    fn content_id_ignores_train_config_id() {
        let (_, raw) = TrainConfig::parse(BASE).expect("valid");
        let mut with_id = raw.clone();
        with_id["train_config_id"] = Value::String("sha256:aa".into());
        assert_eq!(TrainConfig::content_id(&raw).expect("id"), TrainConfig::content_id(&with_id).expect("id"));
    }
}
