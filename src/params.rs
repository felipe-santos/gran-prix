//! Parameter Store — Decoupled parameter management for computation graphs.
//!
//! `ParamStore` owns all trainable parameter tensors and their gradients,
//! independent of the graph topology. This separation enables:
//!
//! - Clean weight export/import without graph internals access
//! - Optimizer updates without knowledge of graph structure
//! - Layer freezing and per-parameter configuration
//! - Safe serialization (params are self-contained)
//!
//! # Design
//!
//! Parameters are identified by [`ParamId`], a typed index that prevents
//! confusion with [`NodeId`]. The store maintains three parallel vectors:
//! tensors, gradients, and metadata (frozen state, names).
//!
//! # Usage
//!
//! ```rust
//! use gran_prix::params::{ParamStore, ParamId};
//! use gran_prix::Tensor;
//!
//! let mut store = ParamStore::new();
//! let id = store.register(Tensor::new_random(&[4, 8]), "linear1.weight");
//! assert_eq!(store.len(), 1);
//!
//! // Export/import as flat vector
//! let flat = store.export_flat().unwrap();
//! store.import_flat(&flat).unwrap();
//! ```

use serde::{Serialize, Deserialize};
use crate::{Tensor, GPError, GPResult};

/// Unique identifier for a parameter within a [`ParamStore`].
///
/// Distinct from [`NodeId`] to prevent accidental misuse — a `ParamId`
/// indexes into the parameter store, not the computation graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ParamId(pub usize);

/// Metadata for a single parameter.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ParamMeta {
    /// Human-readable name for debugging and logging (e.g., "linear1.weight").
    name: String,
    /// If true, this parameter will not be updated by optimizers.
    frozen: bool,
}

/// Centralized store for all trainable parameters and their gradients.
///
/// # Invariants
///
/// - `tensors.len() == gradients.len() == meta.len()` at all times.
/// - A `ParamId(i)` is valid iff `i < self.len()`.
/// - Gradients are `None` until accumulated by a backward pass.
#[derive(Debug, Serialize, Deserialize)]
pub struct ParamStore {
    tensors: Vec<Tensor>,
    #[serde(skip)]
    gradients: Vec<Option<Tensor>>,
    meta: Vec<ParamMeta>,
}

impl ParamStore {
    /// Creates an empty parameter store.
    pub fn new() -> Self {
        Self {
            tensors: Vec::new(),
            gradients: Vec::new(),
            meta: Vec::new(),
        }
    }

    /// Registers a new parameter tensor and returns its identifier.
    ///
    /// # Arguments
    ///
    /// * `tensor` - Initial parameter values.
    /// * `name` - Human-readable name for debugging (e.g., "layer1.weight").
    pub fn register(&mut self, tensor: Tensor, name: &str) -> ParamId {
        let id = ParamId(self.tensors.len());
        self.tensors.push(tensor);
        self.gradients.push(None);
        self.meta.push(ParamMeta {
            name: name.to_string(),
            frozen: false,
        });
        id
    }

    /// Returns the number of registered parameters.
    pub fn len(&self) -> usize {
        self.tensors.len()
    }

    /// Returns true if there are no registered parameters.
    pub fn is_empty(&self) -> bool {
        self.tensors.is_empty()
    }

    // ── Tensor Access ──────────────────────────────────────────────────────

    /// Returns a reference to the parameter tensor.
    ///
    /// # Panics
    ///
    /// Panics if `id` is out of bounds. Use [`get`] for a checked version.
    pub fn tensor(&self, id: ParamId) -> &Tensor {
        &self.tensors[id.0]
    }

    /// Returns a mutable reference to the parameter tensor.
    ///
    /// # Panics
    ///
    /// Panics if `id` is out of bounds.
    pub fn tensor_mut(&mut self, id: ParamId) -> &mut Tensor {
        &mut self.tensors[id.0]
    }

    /// Returns a reference to the parameter tensor, or `None` if out of bounds.
    pub fn get(&self, id: ParamId) -> Option<&Tensor> {
        self.tensors.get(id.0)
    }

    /// Returns a mutable reference to the parameter tensor, or `None` if out of bounds.
    pub fn get_mut(&mut self, id: ParamId) -> Option<&mut Tensor> {
        self.tensors.get_mut(id.0)
    }

    // ── Gradient Access ────────────────────────────────────────────────────

    /// Returns the accumulated gradient for a parameter, if any.
    pub fn gradient(&self, id: ParamId) -> Option<&Tensor> {
        self.gradients.get(id.0).and_then(|g| g.as_ref())
    }

    /// Accumulates a gradient for the given parameter.
    ///
    /// If no gradient exists yet, the provided gradient is stored directly.
    /// If a gradient already exists, the new gradient is added element-wise.
    pub fn accumulate_gradient(&mut self, id: ParamId, grad: Tensor) -> GPResult<()> {
        if id.0 >= self.gradients.len() {
            return Err(GPError::InferenceError(
                format!("ParamId {} out of bounds (store has {} params)", id.0, self.len())
            ));
        }
        match &self.gradients[id.0] {
            Some(existing) => {
                self.gradients[id.0] = Some(existing + &grad);
            }
            None => {
                self.gradients[id.0] = Some(grad);
            }
        }
        Ok(())
    }

    /// Sets the gradient for a parameter directly, replacing any existing gradient.
    pub fn set_gradient(&mut self, id: ParamId, grad: Tensor) {
        if id.0 < self.gradients.len() {
            self.gradients[id.0] = Some(grad);
        }
    }

    /// Clears all accumulated gradients.
    pub fn clear_gradients(&mut self) {
        for g in &mut self.gradients {
            *g = None;
        }
    }

    // ── Freeze / Unfreeze ──────────────────────────────────────────────────

    /// Freezes a parameter so it won't be updated by optimizers.
    pub fn freeze(&mut self, id: ParamId) {
        if let Some(meta) = self.meta.get_mut(id.0) {
            meta.frozen = true;
        }
    }

    /// Unfreezes a parameter so it will be updated by optimizers.
    pub fn unfreeze(&mut self, id: ParamId) {
        if let Some(meta) = self.meta.get_mut(id.0) {
            meta.frozen = false;
        }
    }

    /// Returns true if the parameter is frozen.
    pub fn is_frozen(&self, id: ParamId) -> bool {
        self.meta.get(id.0).map_or(false, |m| m.frozen)
    }

    /// Freezes every parameter whose registered name starts with `prefix`.
    ///
    /// `NetworkDef::compile` registers each layer's parameters under
    /// names like `"layers[3].weight"`, so a prefix `"layers[3]"`
    /// freezes the entire third layer atomically. Returns the count of
    /// parameters affected — `0` is a valid return (no match) and not
    /// an error, so callers that require at least one match should
    /// check the return value.
    ///
    /// Use [`unfreeze_by_name_prefix`] symmetrically to undo. For the
    /// backbone+head fine-tuning pattern, freeze the backbone prefix and
    /// leave the head untouched.
    pub fn freeze_by_name_prefix(&mut self, prefix: &str) -> usize {
        let mut count = 0;
        for meta in self.meta.iter_mut() {
            if meta.name.starts_with(prefix) {
                meta.frozen = true;
                count += 1;
            }
        }
        count
    }

    /// Unfreezes every parameter whose registered name starts with `prefix`.
    /// See [`freeze_by_name_prefix`].
    pub fn unfreeze_by_name_prefix(&mut self, prefix: &str) -> usize {
        let mut count = 0;
        for meta in self.meta.iter_mut() {
            if meta.name.starts_with(prefix) {
                meta.frozen = false;
                count += 1;
            }
        }
        count
    }

    /// Returns the names of all registered parameters in registration
    /// order. The vector index of each name equals the corresponding
    /// `ParamId`, so callers can correlate names with indices.
    pub fn names(&self) -> Vec<&str> {
        self.meta.iter().map(|m| m.name.as_str()).collect()
    }

    // ── Name Access ────────────────────────────────────────────────────────

    /// Returns the human-readable name of a parameter.
    pub fn name(&self, id: ParamId) -> &str {
        self.meta.get(id.0).map_or("unknown", |m| m.name.as_str())
    }

    // ── Iteration ──────────────────────────────────────────────────────────

    /// Iterates over all (id, tensor) pairs.
    pub fn iter(&self) -> impl Iterator<Item = (ParamId, &Tensor)> {
        self.tensors.iter().enumerate().map(|(i, t)| (ParamId(i), t))
    }

    /// Iterates over all (id, tensor) pairs mutably.
    pub fn iter_mut(&mut self) -> impl Iterator<Item = (ParamId, &mut Tensor)> {
        self.tensors.iter_mut().enumerate().map(|(i, t)| (ParamId(i), t))
    }

    /// Returns indices of all trainable parameters that have accumulated gradients.
    ///
    /// This is the primary interface for optimizers: iterate the returned IDs
    /// and call `tensor_mut()` / `gradient()` for each.
    pub fn trainable_param_ids(&self) -> Vec<ParamId> {
        (0..self.tensors.len())
            .filter(|&i| !self.meta[i].frozen && self.gradients[i].is_some())
            .map(ParamId)
            .collect()
    }

    /// Returns the parameter tensor mutably and a **clone** of its gradient.
    ///
    /// The gradient is cloned to avoid the need for simultaneous mutable+immutable
    /// borrows on different struct fields. For typical ML workloads (hundreds of
    /// params, not millions of optimizer steps), this cost is negligible.
    ///
    /// Returns `None` if the parameter has no gradient.
    pub fn param_and_grad(&mut self, id: ParamId) -> Option<(&mut Tensor, Tensor)> {
        if id.0 >= self.tensors.len() || self.gradients[id.0].is_none() {
            return None;
        }
        let grad_clone = self.gradients[id.0].as_ref().unwrap().clone();
        Some((&mut self.tensors[id.0], grad_clone))
    }

    // ── Serialization (Flat Vector) ────────────────────────────────────────

    /// Exports all parameter values as a single flat `Vec<f32>`.
    ///
    /// Parameters are exported in registration order. The caller must know
    /// the architecture to correctly interpret the flat vector.
    pub fn export_flat(&self) -> GPResult<Vec<f32>> {
        let total: usize = self.tensors.iter().map(|t| t.len()).sum();
        let mut weights = Vec::with_capacity(total);
        for tensor in &self.tensors {
            let slice = tensor.as_slice()?;
            weights.extend_from_slice(slice);
        }
        Ok(weights)
    }

    /// Imports parameter values from a flat `Vec<f32>`.
    ///
    /// The flat vector must contain exactly the right number of values
    /// for all parameters in registration order.
    ///
    /// # Threat model
    ///
    /// This is the **trust boundary** for parameter imports. Anything
    /// that crosses this boundary is treated as untrusted — typical
    /// sources include disk files, network responses, browser storage,
    /// and clipboard pastes. The validation guards against:
    ///
    ///  - **Bit-corrupted payloads** (truncated download, partial write,
    ///    flipped bits in storage). These typically appear as NaN/Inf
    ///    or absurd magnitudes in IEEE 754.
    ///  - **Adversarial weights** crafted to overflow downstream matmuls
    ///    or to silently destroy a model loaded from an untrusted source.
    ///  - **Honest-but-stale payloads** from a different model version
    ///    whose weights happen to match in length but in nothing else.
    ///
    /// Validation guarantees:
    ///
    ///  - **Finite check** (mandatory): NaN or ±∞ would propagate
    ///    silently through the next forward pass and corrupt every
    ///    downstream gradient. Rejected with [`GPError::InvalidWeight`].
    ///  - **Magnitude check** (mandatory, soft cap): values whose
    ///    absolute magnitude exceeds [`Self::MAX_WEIGHT_MAGNITUDE`] are
    ///    rejected. Trained-network weights typically live in `[-10, 10]`;
    ///    well-conditioned init or LR schedules don't drift past `1e3`.
    ///    The cap is set generously (`1e6`) to admit pathological-but-
    ///    legitimate cases while flagging obviously corrupted payloads.
    ///
    /// # What is NOT validated
    ///
    /// Gradient accumulation ([`accumulate_gradient`], [`set_gradient`])
    /// is **not** validated — gradients are produced internally by the
    /// engine's backward pass, which is in the trust zone. If an
    /// internal computation produces NaN it indicates a bug elsewhere
    /// (loss too high, learning rate too aggressive, vanishing/exploding
    /// gradient) and validation here would only mask that.
    ///
    /// Shape consistency is validated by `import_flat`'s length check,
    /// not by per-tensor shape comparison — the flat vector is
    /// implicitly typed by the registered tensors.
    ///
    /// # Atomicity
    ///
    /// All values are validated **before** any parameter tensor is
    /// mutated. On a validation error the store is left untouched.
    /// Past validation, mutation proceeds tensor-by-tensor; if a
    /// per-tensor `Tensor::from_shape_vec` fails (e.g., allocator
    /// failure under memory pressure) the store may be left partially
    /// updated. Callers concerned with this edge case should clone the
    /// store before calling and roll back on error.
    pub fn import_flat(&mut self, weights: &[f32]) -> GPResult<()> {
        let total: usize = self.tensors.iter().map(|t| t.len()).sum();
        if weights.len() != total {
            return Err(GPError::WeightLengthMismatch {
                expected: total,
                found: weights.len(),
            });
        }

        for (i, &w) in weights.iter().enumerate() {
            if !w.is_finite() {
                return Err(GPError::InvalidWeight {
                    index: i,
                    reason: if w.is_nan() {
                        "NaN".to_string()
                    } else {
                        format!("non-finite ({})", w)
                    },
                });
            }
            if w.abs() > Self::MAX_WEIGHT_MAGNITUDE {
                return Err(GPError::InvalidWeight {
                    index: i,
                    reason: format!(
                        "magnitude {} exceeds soft cap {}",
                        w, Self::MAX_WEIGHT_MAGNITUDE
                    ),
                });
            }
        }

        let mut offset = 0;
        for tensor in &mut self.tensors {
            let count = tensor.len();
            let slice = &weights[offset..offset + count];
            let shape = tensor.shape().to_vec();
            let new_tensor = Tensor::from_shape_vec(&shape, slice.to_vec())?;
            *tensor = new_tensor;
            offset += count;
        }
        Ok(())
    }

    /// Soft upper bound on the absolute magnitude of any single weight.
    ///
    /// Set generously: 1e6 is well past anything a well-behaved training
    /// run produces, but well below the magnitudes that adversarial or
    /// corrupted payloads typically carry (1e30+). Tuning this lower
    /// would risk false positives on legitimate (if poorly conditioned)
    /// trained models; tuning it higher gives up the protection.
    pub const MAX_WEIGHT_MAGNITUDE: f32 = 1.0e6;

    /// Returns the total number of scalar parameters across all tensors.
    pub fn total_params(&self) -> usize {
        self.tensors.iter().map(|t| t.len()).sum()
    }

    /// Returns the sum of absolute gradient values for each parameter.
    ///
    /// Useful for diagnostics — verifying that backpropagation reaches all layers.
    pub fn gradient_norms(&self) -> GPResult<Vec<f32>> {
        let mut norms = Vec::with_capacity(self.len());
        for grad_opt in &self.gradients {
            match grad_opt {
                Some(grad) => {
                    let slice = grad.as_slice()?;
                    let sum_abs: f32 = slice.iter().map(|x| x.abs()).sum();
                    norms.push(sum_abs);
                }
                None => norms.push(0.0),
            }
        }
        Ok(norms)
    }
}

impl Default for ParamStore {
    fn default() -> Self {
        Self::new()
    }
}

impl Clone for ParamStore {
    fn clone(&self) -> Self {
        Self {
            tensors: self.tensors.clone(),
            gradients: self.gradients.clone(),
            meta: self.meta.clone(),
        }
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_store() -> ParamStore {
        let mut store = ParamStore::new();
        store.register(Tensor::new_zeros(&[2, 3]), "layer1.weight");
        store.register(Tensor::new_zeros(&[1, 3]), "layer1.bias");
        store.register(Tensor::new_zeros(&[3, 4]), "layer2.weight");
        store.register(Tensor::new_zeros(&[1, 4]), "layer2.bias");
        store
    }

    #[test]
    fn test_register_and_len() {
        let store = make_store();
        assert_eq!(store.len(), 4);
        assert!(!store.is_empty());
    }

    #[test]
    fn test_empty_store() {
        let store = ParamStore::new();
        assert_eq!(store.len(), 0);
        assert!(store.is_empty());
    }

    #[test]
    fn test_tensor_access() {
        let store = make_store();
        let t = store.tensor(ParamId(0));
        assert_eq!(t.shape(), &[2, 3]);

        let t = store.tensor(ParamId(2));
        assert_eq!(t.shape(), &[3, 4]);
    }

    #[test]
    fn test_get_returns_none_for_invalid_id() {
        let store = make_store();
        assert!(store.get(ParamId(99)).is_none());
    }

    #[test]
    fn test_tensor_mut() {
        let mut store = make_store();
        let t = store.tensor_mut(ParamId(0));
        // Modify in place
        let slice = t.as_slice_mut().unwrap();
        slice[0] = 42.0;

        let t = store.tensor(ParamId(0));
        assert_eq!(t.as_slice().unwrap()[0], 42.0);
    }

    #[test]
    fn test_names() {
        let store = make_store();
        assert_eq!(store.name(ParamId(0)), "layer1.weight");
        assert_eq!(store.name(ParamId(1)), "layer1.bias");
        assert_eq!(store.name(ParamId(99)), "unknown");
    }

    #[test]
    fn test_freeze_unfreeze() {
        let mut store = make_store();
        assert!(!store.is_frozen(ParamId(0)));

        store.freeze(ParamId(0));
        assert!(store.is_frozen(ParamId(0)));
        assert!(!store.is_frozen(ParamId(1)));

        store.unfreeze(ParamId(0));
        assert!(!store.is_frozen(ParamId(0)));
    }

    #[test]
    fn test_gradient_accumulation() {
        let mut store = make_store();
        assert!(store.gradient(ParamId(0)).is_none());

        let grad1 = Tensor::from_elem(&[2, 3], 1.0);
        store.accumulate_gradient(ParamId(0), grad1).unwrap();

        let g = store.gradient(ParamId(0)).unwrap();
        assert_eq!(g.as_slice().unwrap(), &[1.0; 6]);

        // Accumulate again
        let grad2 = Tensor::from_elem(&[2, 3], 2.0);
        store.accumulate_gradient(ParamId(0), grad2).unwrap();

        let g = store.gradient(ParamId(0)).unwrap();
        assert_eq!(g.as_slice().unwrap(), &[3.0; 6]);
    }

    #[test]
    fn test_clear_gradients() {
        let mut store = make_store();
        let grad = Tensor::from_elem(&[2, 3], 1.0);
        store.accumulate_gradient(ParamId(0), grad).unwrap();
        assert!(store.gradient(ParamId(0)).is_some());

        store.clear_gradients();
        assert!(store.gradient(ParamId(0)).is_none());
    }

    #[test]
    fn test_export_import_flat() {
        let mut store = make_store();
        // Set some values
        {
            let t = store.tensor_mut(ParamId(0));
            let slice = t.as_slice_mut().unwrap();
            for (i, v) in slice.iter_mut().enumerate() {
                *v = i as f32;
            }
        }

        let flat = store.export_flat().unwrap();
        // Total: 2*3 + 1*3 + 3*4 + 1*4 = 6 + 3 + 12 + 4 = 25
        assert_eq!(flat.len(), 25);
        assert_eq!(&flat[0..6], &[0.0, 1.0, 2.0, 3.0, 4.0, 5.0]);

        // Modify and reimport
        let mut modified = flat.clone();
        modified[0] = 99.0;
        store.import_flat(&modified).unwrap();

        let t = store.tensor(ParamId(0));
        assert_eq!(t.as_slice().unwrap()[0], 99.0);
    }

    #[test]
    fn test_import_flat_wrong_length() {
        let mut store = make_store();
        let result = store.import_flat(&[1.0, 2.0, 3.0]);
        assert!(result.is_err());
    }

    #[test]
    fn test_import_flat_rejects_nan() {
        let mut store = make_store();
        let mut weights = vec![0.5_f32; store.total_params()];
        weights[10] = f32::NAN;

        let err = store.import_flat(&weights).unwrap_err();
        match err {
            GPError::InvalidWeight { index, reason } => {
                assert_eq!(index, 10);
                assert!(reason.contains("NaN"), "expected NaN diagnostic, got {reason}");
            }
            other => panic!("expected InvalidWeight, got {other:?}"),
        }

        // Store must remain untouched on a failed import (atomic semantics).
        for tensor in store.tensors.iter() {
            for &v in tensor.as_slice().unwrap() {
                assert_eq!(v, 0.0, "store mutated despite failed import");
            }
        }
    }

    #[test]
    fn test_import_flat_rejects_infinity() {
        let mut store = make_store();
        let mut weights = vec![0.0_f32; store.total_params()];
        weights[3] = f32::INFINITY;
        let err = store.import_flat(&weights).unwrap_err();
        assert!(matches!(err, GPError::InvalidWeight { index: 3, .. }));

        weights[3] = f32::NEG_INFINITY;
        let err = store.import_flat(&weights).unwrap_err();
        assert!(matches!(err, GPError::InvalidWeight { index: 3, .. }));
    }

    #[test]
    fn test_import_flat_boundary_max_magnitude_exact_is_accepted() {
        // Exactly the documented cap is admitted. Anything strictly
        // greater is rejected. This pins the boundary.
        let mut store = make_store();
        let mut weights = vec![0.0_f32; store.total_params()];
        weights[0] = ParamStore::MAX_WEIGHT_MAGNITUDE;
        weights[1] = -ParamStore::MAX_WEIGHT_MAGNITUDE;
        store
            .import_flat(&weights)
            .expect("MAX_WEIGHT_MAGNITUDE itself must be accepted");
        assert_eq!(
            store.tensor(ParamId(0)).as_slice().unwrap()[0],
            ParamStore::MAX_WEIGHT_MAGNITUDE
        );
    }

    #[test]
    fn test_import_flat_boundary_one_above_cap_is_rejected() {
        // The smallest f32 strictly above the cap that we can construct
        // without losing precision: cap + (cap.next_up() - cap).
        let mut store = make_store();
        let mut weights = vec![0.0_f32; store.total_params()];
        let just_above = f32::from_bits(ParamStore::MAX_WEIGHT_MAGNITUDE.to_bits() + 1);
        assert!(just_above > ParamStore::MAX_WEIGHT_MAGNITUDE);
        weights[2] = just_above;

        let err = store.import_flat(&weights).unwrap_err();
        match err {
            GPError::InvalidWeight { index, reason } => {
                assert_eq!(index, 2);
                assert!(reason.contains("magnitude"), "got {reason}");
            }
            other => panic!("expected InvalidWeight, got {other:?}"),
        }
    }

    #[test]
    fn test_import_flat_accepts_realistic_trained_weight_range() {
        // Trained-network weights typically live in [-10, 10]. This
        // sanity-checks that ordinary training output isn't misclassified
        // as "adversarial" by a future tightening of the cap.
        let mut store = make_store();
        let mut weights = vec![0.0_f32; store.total_params()];
        weights[0] = 7.5;
        weights[1] = -3.2;
        weights[10] = 0.001;
        store.import_flat(&weights).expect("ordinary weights admitted");
        assert_eq!(store.tensor(ParamId(0)).as_slice().unwrap()[0], 7.5);
    }

    #[test]
    fn test_import_flat_does_not_mutate_on_first_invalid_value() {
        // A value early in the buffer is invalid — store must stay clean
        // and no later valid value should leak into the store either.
        let mut store = make_store();
        // Initial state: all zeros. Capture for comparison.
        let before: Vec<f32> = store.export_flat().unwrap();

        let mut weights = vec![1.0_f32; store.total_params()];
        weights[0] = f32::NAN;
        let _ = store.import_flat(&weights).unwrap_err();

        let after: Vec<f32> = store.export_flat().unwrap();
        assert_eq!(before, after, "store mutated despite failed import");
    }

    #[test]
    fn test_freeze_by_name_prefix_affects_only_matching_params() {
        let mut store = ParamStore::new();
        store.register(Tensor::new_zeros(&[1]), "layers[0].weight");
        store.register(Tensor::new_zeros(&[1]), "layers[0].bias");
        store.register(Tensor::new_zeros(&[1]), "layers[2].weight");
        store.register(Tensor::new_zeros(&[1]), "layers[2].bias");
        store.register(Tensor::new_zeros(&[1]), "layers[4].weight");
        store.register(Tensor::new_zeros(&[1]), "layers[4].bias");

        let count = store.freeze_by_name_prefix("layers[2]");
        assert_eq!(count, 2, "exactly weight + bias of layer 2");

        assert!(!store.is_frozen(ParamId(0)));
        assert!(!store.is_frozen(ParamId(1)));
        assert!(store.is_frozen(ParamId(2)));
        assert!(store.is_frozen(ParamId(3)));
        assert!(!store.is_frozen(ParamId(4)));
        assert!(!store.is_frozen(ParamId(5)));
    }

    #[test]
    fn test_freeze_by_name_prefix_no_match_returns_zero() {
        let mut store = make_store();
        let count = store.freeze_by_name_prefix("does_not_exist");
        assert_eq!(count, 0);
        for i in 0..store.len() {
            assert!(!store.is_frozen(ParamId(i)));
        }
    }

    #[test]
    fn test_freeze_then_unfreeze_by_name_prefix_round_trips() {
        let mut store = ParamStore::new();
        store.register(Tensor::new_zeros(&[1]), "layers[0].weight");
        store.register(Tensor::new_zeros(&[1]), "layers[1].weight");

        store.freeze_by_name_prefix("layers[");
        assert!(store.is_frozen(ParamId(0)));
        assert!(store.is_frozen(ParamId(1)));

        let count = store.unfreeze_by_name_prefix("layers[");
        assert_eq!(count, 2);
        assert!(!store.is_frozen(ParamId(0)));
        assert!(!store.is_frozen(ParamId(1)));
    }

    #[test]
    fn test_names_returns_all_in_registration_order() {
        let store = make_store();
        let names = store.names();
        assert_eq!(
            names,
            vec!["layer1.weight", "layer1.bias", "layer2.weight", "layer2.bias"]
        );
    }

    #[test]
    fn test_serialization_round_trips_param_names() {
        // The `name` field of `ParamMeta` is part of the serialized
        // payload — losing it on round-trip would silently break the
        // freeze-by-name API after a save/load cycle.
        let mut store = ParamStore::new();
        store.register(Tensor::new_zeros(&[1]), "layers[3].weight");
        store.register(Tensor::new_zeros(&[1]), "layers[3].bias");

        let json = serde_json::to_string(&store).unwrap();
        let restored: ParamStore = serde_json::from_str(&json).unwrap();
        assert_eq!(
            restored.names(),
            vec!["layers[3].weight", "layers[3].bias"]
        );
    }

    #[test]
    fn test_accumulate_gradient_does_not_validate_input() {
        // Documents the asymmetric trust model: gradient accumulation
        // is in the trust zone. If a NaN gradient ever appears here it
        // means an upstream component (loss, backward pass, optimizer)
        // produced it — validating in this method would mask that bug
        // rather than fix it.
        //
        // Locking this behavior down by test means a future change that
        // adds validation here must also revisit the threat model in
        // `import_flat`'s docstring.
        let mut store = make_store();
        let nan_grad = Tensor::from_shape_vec(&[2, 3], vec![f32::NAN; 6]).unwrap();
        store
            .accumulate_gradient(ParamId(0), nan_grad)
            .expect("accumulate_gradient deliberately accepts any tensor");
        let g = store.gradient(ParamId(0)).unwrap();
        assert!(g.as_slice().unwrap()[0].is_nan());
    }

    #[test]
    fn test_total_params() {
        let store = make_store();
        // 2*3 + 1*3 + 3*4 + 1*4 = 25
        assert_eq!(store.total_params(), 25);
    }

    #[test]
    fn test_gradient_norms() {
        let mut store = make_store();

        // No gradients yet
        let norms = store.gradient_norms().unwrap();
        assert_eq!(norms, vec![0.0; 4]);

        // Add gradient to first param
        let grad = Tensor::from_elem(&[2, 3], -2.0);
        store.accumulate_gradient(ParamId(0), grad).unwrap();

        let norms = store.gradient_norms().unwrap();
        assert_eq!(norms[0], 12.0); // 6 elements * abs(-2.0)
        assert_eq!(norms[1], 0.0);
    }

    #[test]
    fn test_trainable_param_ids() {
        let mut store = make_store();

        // Add gradients to params 0 and 2
        let grad0 = Tensor::from_elem(&[2, 3], 1.0);
        let grad2 = Tensor::from_elem(&[3, 4], 1.0);
        store.accumulate_gradient(ParamId(0), grad0).unwrap();
        store.accumulate_gradient(ParamId(2), grad2).unwrap();

        // Freeze param 0
        store.freeze(ParamId(0));

        let trainable = store.trainable_param_ids();
        // Only param 2 should appear (param 0 is frozen, params 1,3 have no grads)
        assert_eq!(trainable, vec![ParamId(2)]);

        // param_and_grad should work for trainable params
        let (tensor, grad) = store.param_and_grad(ParamId(2)).unwrap();
        assert_eq!(tensor.shape(), &[3, 4]);
        assert_eq!(grad.shape(), &[3, 4]);

        // Frozen param should not appear but param_and_grad still works
        assert!(store.param_and_grad(ParamId(0)).is_some()); // has grad, even if frozen
    }

    #[test]
    fn test_iter() {
        let store = make_store();
        let ids: Vec<ParamId> = store.iter().map(|(id, _)| id).collect();
        assert_eq!(ids, vec![ParamId(0), ParamId(1), ParamId(2), ParamId(3)]);
    }

    #[test]
    fn test_clone() {
        let mut store = make_store();
        let grad = Tensor::from_elem(&[2, 3], 5.0);
        store.accumulate_gradient(ParamId(0), grad).unwrap();

        let cloned = store.clone();
        assert_eq!(cloned.len(), store.len());
        assert_eq!(
            cloned.tensor(ParamId(0)).as_slice().unwrap(),
            store.tensor(ParamId(0)).as_slice().unwrap()
        );
        assert!(cloned.gradient(ParamId(0)).is_some());
    }

    #[test]
    fn test_set_gradient() {
        let mut store = make_store();
        let grad1 = Tensor::from_elem(&[2, 3], 1.0);
        store.accumulate_gradient(ParamId(0), grad1).unwrap();

        // Replace (not accumulate)
        let grad2 = Tensor::from_elem(&[2, 3], 99.0);
        store.set_gradient(ParamId(0), grad2);

        let g = store.gradient(ParamId(0)).unwrap();
        assert_eq!(g.as_slice().unwrap(), &[99.0; 6]);
    }

    #[test]
    fn test_accumulate_gradient_out_of_bounds() {
        let mut store = make_store();
        let grad = Tensor::new_zeros(&[2, 3]);
        let result = store.accumulate_gradient(ParamId(99), grad);
        assert!(result.is_err());
    }

    #[test]
    fn test_serialization_roundtrip() {
        let mut store = make_store();
        {
            let t = store.tensor_mut(ParamId(0));
            let slice = t.as_slice_mut().unwrap();
            slice[0] = 42.0;
        }

        let json = serde_json::to_string(&store).unwrap();
        let restored: ParamStore = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.len(), 4);
        assert_eq!(restored.tensor(ParamId(0)).as_slice().unwrap()[0], 42.0);
        assert_eq!(restored.name(ParamId(0)), "layer1.weight");
        // Gradients are skipped in serialization
        assert!(restored.gradient(ParamId(0)).is_none());
    }
}
