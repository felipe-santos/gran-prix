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

/// What a weighted batch adds to the epoch loss: `loss_sum = sum(w_i * l_i)`, `weight_sum = sum(w_i)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WeightedBatch {
    pub loss_sum: f32,
    pub weight_sum: f64,
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

    /// `train_batch` with a weight per row (`w`, indexed like `y`): the batch loss is
    /// `sum(w_i * l_i) / sum(w_i)` over `idx`, so each sample's logit gradient is
    /// `w_i * dl/dz / sum(w)`. Rows with `w = 0` are skipped; a batch whose weights sum to 0
    /// does nothing at all (no forward, no optimizer step) and reports `(0, 0)`.
    pub fn train_batch_weighted(&mut self, x: &[f32], y: &[u8], w: &[f32], idx: &[usize], loss: &WeightedBce, opt: &mut Adam) -> Result<WeightedBatch> {
        let weight_sum: f64 = idx.iter().map(|&i| f64::from(w[i])).sum();
        if idx.is_empty() || !(weight_sum > 0.0) {
            return Ok(WeightedBatch { loss_sum: 0.0, weight_sum: 0.0 });
        }
        self.compiled.graph.clear_gradients();
        self.compiled.graph.set_training(true);
        let result = self.accumulate_weighted(x, y, w, idx, loss, weight_sum as f32);
        self.compiled.graph.set_training(false);
        let loss_sum = result?;
        opt.step(self.compiled.graph.params_mut())?;
        Ok(WeightedBatch { loss_sum, weight_sum })
    }

    fn accumulate_weighted(&mut self, x: &[f32], y: &[u8], w: &[f32], idx: &[usize], loss: &WeightedBce, denom: f32) -> Result<f32> {
        let mut total = 0.0f32;
        for &i in idx {
            if w[i] <= 0.0 {
                continue;
            }
            let row = &x[i * self.dim..(i + 1) * self.dim];
            let logit = self.forward(Tensor::from_shape_vec(&[1, self.dim], row.to_vec())?)?.as_slice()?[0];
            total += w[i] * loss.loss(logit, y[i]);
            let grad = Tensor::from_shape_vec(&[1, 1], vec![w[i] * loss.grad(logit, y[i]) / denom])?;
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

    const WX: [f32; 9] = [1.0, 0.5, -0.3, -1.0, -0.5, 0.3, 0.8, 0.1, -0.2];
    const WY: [u8; 3] = [1, 0, 1];

    fn one_step(idx: &[usize], w: Option<&[f32]>, x: &[f32], y: &[u8]) -> (Vec<f32>, Option<WeightedBatch>) {
        let mut net = Net::new(&def(), Some(9)).expect("compiles");
        let mut opt = Adam::new(0.05);
        let loss = WeightedBce::new(1.5);
        let r = match w {
            Some(w) => Some(net.train_batch_weighted(x, y, w, idx, &loss, &mut opt).expect("step")),
            None => {
                net.train_batch(x, y, idx, &loss, &mut opt).expect("step");
                None
            }
        };
        (net.weights().expect("w"), r)
    }

    /// With every weight 1 the weighted step is the plain step, bit for bit.
    #[test]
    fn unit_weights_give_the_plain_step_bitwise() {
        let (plain, _) = one_step(&[0, 1, 2], None, &WX, &WY);
        let (weighted, r) = one_step(&[0, 1, 2], Some(&[1.0, 1.0, 1.0]), &WX, &WY);
        assert_eq!(plain, weighted);
        assert_eq!(r.map(|b| b.weight_sum), Some(3.0));
    }

    /// A row of weight 2 is two copies of the row (same loss, same gradient): the step on
    /// batch [a, b] with w = [2, 1] equals the step on batch [a, a, b] without weights.
    #[test]
    fn a_weight_of_k_is_k_copies_of_the_row() {
        let x: Vec<f32> = [&WX[0..3], &WX[0..3], &WX[3..6]].concat();
        let (copies, _) = one_step(&[0, 1, 2], None, &x, &[1, 1, 0]);
        let (weighted, r) = one_step(&[0, 1], Some(&[2.0, 1.0]), &WX[0..6], &WY[0..2]);
        assert_eq!(copies.len(), weighted.len());
        for (a, b) in copies.iter().zip(&weighted) {
            assert!((a - b).abs() < 1e-6, "{a} vs {b}");
        }
        assert_eq!(r.map(|b| b.weight_sum), Some(3.0));
    }

    /// A zero-weight row is absent: same bytes as the batch without it.
    #[test]
    fn a_zero_weight_row_is_absent_from_the_step() {
        let (without, _) = one_step(&[0, 1], Some(&[3.0, 5.0]), &WX[0..6], &WY[0..2]);
        let (with_zero, _) = one_step(&[0, 1, 2], Some(&[3.0, 5.0, 0.0]), &WX, &WY);
        assert_eq!(without, with_zero);
    }

    /// `sum(w) = 0` in a batch: nothing happens (no step, no loss), and the weights stay as initialized.
    #[test]
    fn a_batch_of_zero_total_weight_is_a_no_op() {
        let init = Net::new(&def(), Some(9)).expect("compiles").weights().expect("w");
        let (after, r) = one_step(&[0, 1, 2], Some(&[0.0, 0.0, 0.0]), &WX, &WY);
        assert_eq!(init, after);
        assert_eq!(r, Some(WeightedBatch { loss_sum: 0.0, weight_sum: 0.0 }));
        let (after_empty, r) = one_step(&[], Some(&[0.0, 0.0, 0.0]), &WX, &WY);
        assert_eq!((init, r), (after_empty, Some(WeightedBatch { loss_sum: 0.0, weight_sum: 0.0 })));
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
