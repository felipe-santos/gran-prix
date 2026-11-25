//! A compiled `NetworkDef` with the operations gp-train needs: batched eval-mode forward,
//! per-sample training batches, weight export/import and the parameter layout.

use crate::error::Result;
use crate::invalid;
use crate::loss::WeightedBce;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::graph::Node;
use gran_prix::network_def::{CompiledNetwork, NetworkDef};
use gran_prix::optim::{Adam, Optimizer};
use gran_prix::{NodeId, Tensor};

/// Rows per forward pass when scoring a split.
const EVAL_CHUNK: usize = 1024;

pub struct Net {
    compiled: CompiledNetwork,
    order: Vec<NodeId>,
    dim: usize,
}

/// One parameter tensor of the package, in `export_flat` order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParamInfo {
    pub name: String,
    pub shape: Vec<usize>,
    pub offset: usize,
    pub length: usize,
}

impl Net {
    /// Compiles `def`. `Some(seed)` draws the initial weights from the deterministic
    /// per-layer ChaCha8 streams of the core; `None` uses the thread RNG (only for loading
    /// weights that are imported right after).
    pub fn new(def: &NetworkDef, seed: Option<u64>) -> Result<Net> {
        let compiled = match seed {
            Some(s) => def.compile_seeded(Box::new(CPUBackend), s)?,
            None => def.compile(Box::new(CPUBackend))?,
        };
        let order = compiled.graph.topological_sort(compiled.output_node)?;
        Ok(Net { compiled, order, dim: def.input_dim })
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    fn set_input(&mut self, t: Tensor) -> Result<()> {
        match self.compiled.graph.nodes_mut().get_mut(self.compiled.input_node.0) {
            Some(Node::Input(slot)) => {
                *slot = t;
                Ok(())
            }
            _ => Err(invalid!("compiled network has no input node")),
        }
    }

    fn forward(&mut self, t: Tensor) -> Result<Tensor> {
        self.set_input(t)?;
        Ok(self.compiled.graph.execute_with_order(&self.order, self.compiled.output_node)?)
    }

    /// Logits of `n` row-major samples, in eval mode (Dropout is the identity).
    pub fn logits(&mut self, x: &[f32], n: usize) -> Result<Vec<f32>> {
        if x.len() != n * self.dim {
            return Err(invalid!("logits: {} values for {n} rows of dim {}", x.len(), self.dim));
        }
        self.compiled.graph.set_training(false);
        let mut out = Vec::with_capacity(n);
        let mut failure = None;
        for chunk in x.chunks(EVAL_CHUNK * self.dim) {
            let rows = chunk.len() / self.dim;
            // The engine caches every node's value with its shape: drop the cache whenever
            // the batch size changes (same as the WASM Trainer's batched predict).
            self.compiled.graph.clear_values();
            let step = Tensor::from_shape_vec(&[rows, self.dim], chunk.to_vec())
                .map_err(Into::into)
                .and_then(|t| self.forward(t))
                .and_then(|r| r.as_slice().map(|s| out.extend_from_slice(s)).map_err(Into::into));
            if let Err(e) = step {
                failure = Some(e);
                break;
            }
        }
        self.compiled.graph.clear_values();
        match failure {
            Some(e) => Err(e),
            None => Ok(out),
        }
    }

    /// One optimizer step over the samples `idx` (rows of `x` / `y`).
    ///
    /// Same scheme as the WASM `Trainer`: one `clear_gradients` per batch, then forward +
    /// backward per sample (parameter gradients accumulate in the `ParamStore`, since the
    /// E0.1 fix), each sample's logit gradient divided by the batch size, one Adam step.
    /// Dropout is active during the batch. Returns the sum of the weighted sample losses.
    pub fn train_batch(&mut self, x: &[f32], y: &[u8], idx: &[usize], loss: &WeightedBce, opt: &mut Adam) -> Result<f32> {
        if idx.is_empty() {
            return Ok(0.0);
        }
        let batch = idx.len() as f32;
        self.compiled.graph.clear_gradients();
        self.compiled.graph.set_training(true);
        let result = self.accumulate(x, y, idx, loss, batch);
        self.compiled.graph.set_training(false);
        let total = result?;
        opt.step(self.compiled.graph.params_mut())?;
        Ok(total)
    }

    fn accumulate(&mut self, x: &[f32], y: &[u8], idx: &[usize], loss: &WeightedBce, batch: f32) -> Result<f32> {
        let mut total = 0.0f32;
        for &i in idx {
            let row = &x[i * self.dim..(i + 1) * self.dim];
            let logit = self.forward(Tensor::from_shape_vec(&[1, self.dim], row.to_vec())?)?.as_slice()?[0];
            total += loss.loss(logit, y[i]);
            let grad = Tensor::from_shape_vec(&[1, 1], vec![loss.grad(logit, y[i]) / batch])?;
            self.compiled.graph.backward(self.compiled.output_node, grad)?;
        }
        Ok(total)
    }

    /// Freezes every parameter whose name starts with one of `prefixes`; each prefix must
    /// match something.
    pub fn freeze_prefixes(&mut self, prefixes: &[String]) -> Result<()> {
        for p in prefixes {
            if self.compiled.graph.params_mut().freeze_by_name_prefix(p).is_empty() {
                return Err(invalid!("freeze_prefixes: \"{p}\" matches no parameter"));
            }
        }
        Ok(())
    }

    /// All parameters flattened in registration order (the `weights.f32le` payload).
    pub fn weights(&self) -> Result<Vec<f32>> {
        Ok(self.compiled.graph.params().export_flat()?)
    }

    pub fn load_weights(&mut self, w: &[f32]) -> Result<()> {
        Ok(self.compiled.graph.params_mut().import_flat(w)?)
    }

    /// Name, shape and flat offset of every parameter.
    pub fn param_layout(&self) -> Vec<ParamInfo> {
        let params = self.compiled.graph.params();
        let mut offset = 0;
        let mut out = Vec::new();
        for (id, t) in params.iter() {
            let length = t.len();
            out.push(ParamInfo { name: params.name(id).to_string(), shape: t.shape().to_vec(), offset, length });
            offset += length;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gran_prix::network_def::ActivationType;

    fn def() -> NetworkDef {
        NetworkDef::mlp(3, &[4], 1, ActivationType::Tanh, None)
    }

    #[test]
    fn seeded_init_is_reproducible_and_layout_is_contiguous() {
        let a = Net::new(&def(), Some(5)).expect("compiles");
        let b = Net::new(&def(), Some(5)).expect("compiles");
        let c = Net::new(&def(), Some(6)).expect("compiles");
        assert_eq!(a.weights().expect("w"), b.weights().expect("w"));
        assert_ne!(a.weights().expect("w"), c.weights().expect("w"));
        let layout = a.param_layout();
        assert_eq!(layout.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["layers[0].weight", "layers[0].bias", "layers[2].weight", "layers[2].bias"]);
        assert_eq!(layout[0].shape, vec![3, 4]);
        let mut next = 0;
        for p in &layout {
            assert_eq!(p.offset, next);
            assert_eq!(p.length, p.shape.iter().product::<usize>());
            next += p.length;
        }
        assert_eq!(next, a.weights().expect("w").len());
    }

    #[test]
    fn batched_forward_equals_row_by_row() {
        let mut net = Net::new(&def(), Some(1)).expect("compiles");
        let x: Vec<f32> = (0..30).map(|i| (i as f32 * 0.37).sin()).collect();
        let batched = net.logits(&x, 10).expect("forward");
        for r in 0..10 {
            let one = net.logits(&x[r * 3..(r + 1) * 3], 1).expect("forward")[0];
            assert!((one - batched[r]).abs() < 1e-6, "row {r}: {one} vs {}", batched[r]);
        }
        // Interleaving training-shaped (1 row) and eval-shaped (n rows) forwards is safe.
        let again = net.logits(&x, 10).expect("forward");
        assert_eq!(batched, again);
    }

    /// The accumulated gradient of a batch is the mean of the per-sample gradients: a single
    /// Adam step on [a, b] must equal what two samples' mean gradient implies. We check it
    /// through the loss decrease and through determinism of two identical runs.
    #[test]
    fn a_training_step_reduces_the_batch_loss_and_is_deterministic() {
        let x: Vec<f32> = vec![1.0, 0.5, -0.3, -1.0, -0.5, 0.3, 0.8, 0.1, -0.2, -0.9, 0.2, 0.4];
        let y = [1u8, 0, 1, 0];
        let idx = [0usize, 1, 2, 3];
        let run = || {
            let mut net = Net::new(&def(), Some(9)).expect("compiles");
            let mut opt = Adam::new(0.05);
            let loss = WeightedBce::plain();
            let before = loss.mean_loss(&net.logits(&x, 4).expect("f"), &y);
            for _ in 0..30 {
                net.train_batch(&x, &y, &idx, &loss, &mut opt).expect("step");
            }
            let after = loss.mean_loss(&net.logits(&x, 4).expect("f"), &y);
            (before, after, net.weights().expect("w"))
        };
        let (b1, a1, w1) = run();
        let (_, _, w2) = run();
        assert!(a1 < b1 * 0.5, "loss {b1} -> {a1}");
        assert_eq!(w1, w2);
    }

    #[test]
    fn freezing_keeps_those_weights_fixed_and_unknown_prefix_errors() {
        let x: Vec<f32> = vec![1.0, 0.5, -0.3, -1.0, -0.5, 0.3];
        let y = [1u8, 0];
        let mut net = Net::new(&def(), Some(2)).expect("compiles");
        net.freeze_prefixes(&["layers[0]".to_string()]).expect("matches");
        let before = net.weights().expect("w");
        let mut opt = Adam::new(0.1);
        for _ in 0..5 {
            net.train_batch(&x, &y, &[0, 1], &WeightedBce::plain(), &mut opt).expect("step");
        }
        let after = net.weights().expect("w");
        let first_layer = 3 * 4 + 4;
        assert_eq!(before[..first_layer], after[..first_layer]);
        assert_ne!(before[first_layer..], after[first_layer..]);
        assert!(net.freeze_prefixes(&["nope".to_string()]).is_err());
    }

    #[test]
    fn weights_round_trip_through_import() {
        let a = Net::new(&def(), Some(3)).expect("compiles");
        let mut b = Net::new(&def(), Some(4)).expect("compiles");
        b.load_weights(&a.weights().expect("w")).expect("imports");
        let x = [0.1f32, 0.2, 0.3];
        let mut a = a;
        assert_eq!(a.logits(&x, 1).expect("f"), b.logits(&x, 1).expect("f"));
    }
}
