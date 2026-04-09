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
    pub fn import_flat(&mut self, weights: &[f32]) -> GPResult<()> {
        let total: usize = self.tensors.iter().map(|t| t.len()).sum();
        if weights.len() != total {
            return Err(GPError::WeightLengthMismatch {
                expected: total,
                found: weights.len(),
            });
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
