//! Neural Network Brain for WASM Agents
//!
//! This module implements `NeuralBrain`, a feedforward neural network optimized
//! for WebAssembly environments with zero-allocation forward passes.
//!
//! # Architecture
//!
//! - **Input → Hidden → Output** (2-layer MLP)
//! - **Activations**: ReLU (hidden), Sigmoid (output)
//! - **Custom kernel**: Optional 1D convolution preprocessing
//!
//! # Performance Optimizations
//!
//! - Pre-allocated input tensor (no allocs in `compute()`)
//! - Re-entrancy protection via `ComputingGuard`
//! - Corruption detection via magic number
//! - Lazy value caching in computation graph
//!
//! # Safety Invariants
//!
//! - **Magic number**: `0xDEADC0DE` guards against memory corruption
//! - **Computing flag**: Prevents re-entrant calls
//! - **RefCell**: Interior mutability for WASM single-threaded execution

use std::cell::RefCell;

use wasm_bindgen::prelude::*;
use serde::Serialize;
use ndarray::{Array, IxDyn};

use gran_prix::{Tensor, GPError};
use gran_prix::graph::{Graph, dsl::GraphBuilder};
use gran_prix::backend::cpu::CPUBackend;

use crate::mutation::{MutationStrategy, XorShift};

/// Magic number for corruption detection
///
/// If `NeuralBrain.magic != BRAIN_MAGIC`, the brain struct has been corrupted
/// (e.g., by WASM heap overflow, use-after-free, or memory reinterpretation).
const BRAIN_MAGIC: u32 = 0xDEADC0DE;

/// Neural network brain for evolutionary agents
///
/// # Design
///
/// `NeuralBrain` wraps a computation graph and exposes a simple `compute()`
/// interface for forward passes. It's designed for:
///
/// - **Evolution**: Weights can be exported/imported/mutated
/// - **Zero-alloc inference**: Input tensor is pre-allocated
/// - **Corruption safety**: Magic number detects memory issues
/// - **WASM compatibility**: Uses `RefCell` for interior mutability
///
/// # Examples
///
/// ```no_run
/// use gran_prix_wasm::NeuralBrain;
///
/// let brain = NeuralBrain::new(0, 4, vec![8], 2).unwrap();
/// let outputs = brain.compute(&[1.0, 0.5, -0.3, 0.8]).unwrap();
/// ```
#[wasm_bindgen]
pub struct NeuralBrain {
    /// Computation graph holding network structure
    graph: RefCell<Graph>,
    /// Input node ID in graph
    input_node: usize,
    /// Output node ID in graph
    output_node: usize,
    /// Pre-allocated input tensor (avoid allocation in compute)
    input_tensor: RefCell<Tensor>,
    /// Pre-allocated output tensor (avoid allocation in compute)
    output_tensor: RefCell<Tensor>,
    /// Magic number for corruption detection
    magic: u32,
    /// Re-entrancy protection flag
    computing: RefCell<bool>,
    /// Custom 1D convolution kernel (size 3)
    custom_kernel: RefCell<Vec<f32>>,
}

/// RAII guard for re-entrancy protection
///
/// Automatically resets `computing` flag on drop, even if computation panics.
struct ComputingGuard<'a>(&'a RefCell<bool>);

impl<'a> Drop for ComputingGuard<'a> {
    fn drop(&mut self) {
        *self.0.borrow_mut() = false;
    }
}

#[wasm_bindgen]
impl NeuralBrain {
    /// Create a new neural network brain
    ///
    /// # Arguments
    ///
    /// * `seed_offset` - Seed for deterministic weight initialization
    /// * `num_inputs` - Number of input neurons
    /// * `hidden_size` - Number of hidden neurons
    /// * `num_outputs` - Number of output neurons
    ///
    /// # Returns
    ///
    /// New brain instance or error if graph construction fails
    ///
    /// # Weight Initialization
    ///
    /// Weights are initialized with alternating signs to guarantee steering
    /// variance in the population. This prevents all agents from behaving
    /// identically at generation 0.
    ///
    /// w[i] = sign * 0.1 where sign = (-1)^(i + seed_offset)
    #[wasm_bindgen(constructor)]
    pub fn new(
        seed_offset: usize,
        num_inputs: usize,
        hidden_layers: Vec<usize>,
        num_outputs: usize,
    ) -> Result<NeuralBrain, JsValue> {
        let backend = Box::new(CPUBackend);
        let mut graph = Graph::new(backend);
        let mut gb = GraphBuilder::new(&mut graph);

        let input_tensor = Tensor::new_zeros(&[1, num_inputs]);
        let input_id = gb.val(input_tensor);

        // Deterministic alternating weights to GUARANTEE steering variance.
        let alternating_tensor = |rows, cols, offset| {
            let total = rows * cols;
            let mut data = Vec::with_capacity(total);
            for i in 0..total {
                let sign = if (i + offset) % 2 == 0 { 1.0 } else { -1.0 };
                data.push(sign * 0.1);
            }
            Tensor::new_cpu(
                Array::from_shape_vec(IxDyn(&[rows, cols]), data)
                    .expect("Shape mismatch in alternating_tensor")
            )
        };

        let mut current_size = num_inputs;
        let mut last_node = input_id;

        // Build Hidden Layers
        for (i, &hidden_size) in hidden_layers.iter().enumerate() {
            let w = gb.param(alternating_tensor(current_size, hidden_size, seed_offset + i * 100));
            let b = gb.param(Tensor::new_zeros(&[1, hidden_size]));
            let layer = gb.matmul(last_node, w);
            let layer = gb.add(layer, b);
            last_node = gb.relu(layer);
            current_size = hidden_size;
        }

        // Final Output Layer
        let w_final = gb.param(alternating_tensor(current_size, num_outputs, seed_offset + 1000));
        let b_final = gb.param(Tensor::new_zeros(&[1, num_outputs]));
        let output = gb.matmul(last_node, w_final);
        let output = gb.add(output, b_final);
        let final_output = gb.sigmoid(output);

        Ok(NeuralBrain {
            graph: RefCell::new(graph),
            input_node: input_id.0,
            output_node: final_output.0,
            input_tensor: RefCell::new(Tensor::new_zeros(&[1, num_inputs])),
            output_tensor: RefCell::new(Tensor::new_zeros(&[1, num_outputs])),
            magic: BRAIN_MAGIC,
            computing: RefCell::new(false),
            custom_kernel: RefCell::new(vec![0.0, 1.0, 0.0]), // Identity kernel
        })
    }

    /// Compute forward pass through the network
    ///
    /// # Arguments
    ///
    /// * `inputs` - Input values (length must match `num_inputs` from constructor)
    ///
    /// # Returns
    ///
    /// Output values (length = `num_outputs`) or error
    ///
    /// # Errors
    ///
    /// - `"Corrupted before compute"`: Magic number mismatch (memory corruption)
    /// - `"Re-entrant call detected"`: Attempting to call `compute` while already computing
    /// - Graph execution errors
    ///
    /// # Performance
    ///
    /// This is the **hot path** for inference. Optimizations:
    /// - Pre-allocated input tensor (no heap allocation)
    /// - Single borrow of `RefCell` per phase
    /// - Minimal error handling overhead
    pub fn compute(&self, inputs: &[f32]) -> Result<Vec<f32>, JsValue> {
        // Corruption check BEFORE any work
        if self.magic != BRAIN_MAGIC {
            return Err(JsValue::from_str("Corrupted before compute"));
        }

        // Re-entrancy protection (RAII guard)
        let _guard = {
            let mut computing = self.computing.borrow_mut();
            if *computing {
                return Err(JsValue::from_str("Re-entrant call detected"));
            }
            *computing = true;
            ComputingGuard(&self.computing)
        };

        let result = self.compute_internal(inputs);

        // Corruption check AFTER computation
        if self.magic != BRAIN_MAGIC {
            // Brain corrupted during execution (serious bug!)
            return Err(JsValue::from_str("Corrupted after compute"));
        }

        result
    }

    /// Internal compute logic (separated for RAII guard scope)
    ///
    /// # Algorithm
    ///
    /// 1. Apply 1D convolution to inputs (optional preprocessing)
    /// 2. Copy processed inputs to graph input node
    /// 3. Execute topological sorted graph
    /// 4. Extract output values
    ///
    /// # Panics
    ///
    /// Should not panic in normal operation. Uses `?` for error propagation.
    fn compute_internal(&self, inputs: &[f32]) -> Result<Vec<f32>, JsValue> {
        let num_inputs = inputs.len();
        let mut input_buffer = self.input_tensor.borrow_mut();

        // ── Optimized 1D Convolution ───────────────────────────────────────────
        // Apply kernel in-place to the pre-allocated input_buffer to avoid Vec alloc.
        {
            let mut view = input_buffer
                .try_view_mut()
                .map_err(|e| JsValue::from_str(&format!("Buffer view error: {}", e)))?;

            let kernel = self.custom_kernel.borrow();

            for i in 0..num_inputs {
                let mut acc = 0.0;
                for k in 0..3 {
                    let idx = i as i32 + k as i32 - 1;
                    if idx >= 0 && idx < num_inputs as i32 {
                        acc += inputs[idx as usize] * kernel[k];
                    }
                }
                if let Some(v) = view.get_mut(ndarray::IxDyn(&[0, i])) {
                    *v = acc;
                }
            }
        }

        let mut graph = self.graph.borrow_mut();
        graph.sync_params().map_err(|e| JsValue::from_str(&format!("Sync error: {}", e)))?;

        // ── Inject input into graph ───────────────────────────────────────────
        {
            let nodes = graph.nodes_mut();
            if let Some(gran_prix::graph::Node::Input(ref mut t)) = nodes.get_mut(self.input_node) {
                t.copy_from(&input_buffer)
                    .map_err(|e| JsValue::from_str(&format!("Copy error: {}", e)))?;
            }
        }

        let output_id = gran_prix::NodeId(self.output_node);
        let order = graph
            .topological_sort(output_id)
            .map_err(|e| JsValue::from_str(&format!("Sort error: {}", e)))?;

        // ── Execute Graph ──────────────────────────────────────────────────────
        for node_id in order {
            if self.magic != BRAIN_MAGIC {
                return Err(JsValue::from_str("Heap corruption detected mid-execution"));
            }

            graph
                .execute_single_node(node_id)
                .map_err(|e| JsValue::from_str(&format!("Node {} execution error: {}", node_id.0, e)))?;
        }

        // ── Extract Output Efficiently ─────────────────────────────────────────
        let values = graph.values();
        let result_tensor = values
            .get(self.output_node)
            .and_then(|t: &Option<Tensor>| t.as_ref())
            .ok_or_else(|| JsValue::from_str("Output not found"))?;

        let mut out_buffer = self.output_tensor.borrow_mut();
        out_buffer.copy_from(result_tensor)
            .map_err(|e| JsValue::from_str(&format!("Extract error: {}", e)))?;

        let cpu_view = out_buffer
            .as_cpu()
            .map_err(|e| JsValue::from_str(&format!("Failed to get CPU view: {}", e)))?;

        Ok(cpu_view.iter().cloned().collect())
    }

    /// Reset cached values and gradients in the graph
    ///
    /// This is typically called between generations or training epochs.
    pub fn reset(&self) {
        let mut graph = self.graph.borrow_mut();
        graph.clear_values();
        graph.clear_gradients();
    }

    /// Simple training step (placeholder for reinforcement learning)
    ///
    /// # Arguments
    ///
    /// * `_sensors` - Input sensor data (unused currently)
    /// * `_target` - Target value (unused currently)
    ///
    /// # Returns
    ///
    /// Always `Ok(())` (no-op implementation)
    ///
    /// # Design Note
    ///
    /// This is a placeholder for future RL integration. Current evolution
    /// doesn't use gradient-based learning.
    pub fn train(&self, _sensors: &[f32], _target: f32) -> Result<(), JsValue> {
        Ok(())
    }

    /// Export all network weights as flat vector
    ///
    /// # Returns
    ///
    /// Flattened weight vector in graph order
    ///
    /// # Use Case
    ///
    /// Used by evolution to extract parent weights for offspring.
    pub fn export_weights(&self) -> Result<Vec<f32>, JsValue> {
        let graph = self.graph.borrow();
        let nodes = graph.nodes();

        let mut weights = Vec::new();

        for node in nodes.iter() {
            if let gran_prix::graph::Node::Param(t) = node {
                let view = t
                    .as_cpu()
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
                weights.extend(view.iter());
            }
        }

        Ok(weights)
    }

    /// Import weights into network
    ///
    /// # Arguments
    ///
    /// * `weights` - Flat weight vector (must match network size)
    ///
    /// # Returns
    ///
    /// `Ok(())` on success, error if weight array is too short
    ///
    /// # Use Case
    ///
    /// Used by evolution to inject parent/mutated weights into offspring.
    ///
    /// # Important Note
    ///
    /// This works correctly when called on a **fresh brain** (newly constructed).
    /// If called on an already-run brain, you must call `reset()` to clear cached values.
    pub fn import_weights(&self, weights: &[f32]) -> Result<(), JsValue> {
        let mut graph = self.graph.borrow_mut();
        let nodes = graph.nodes_mut();

        let mut w_idx = 0;

        for node in nodes.iter_mut() {
            if let gran_prix::graph::Node::Param(ref mut t) = node {
                let shape = t.shape().to_vec();
                let count = t.len();

                if w_idx + count > weights.len() {
                    return Err(JsValue::from_str("Weights array too short"));
                }

                let slice = &weights[w_idx..w_idx + count];
                // SAFETY: Shape matches count by construction (count = t.len())
                let new_tensor = Tensor::new_cpu(
                    Array::from_shape_vec(IxDyn(&shape), slice.to_vec())
                        .expect("Shape mismatch in import_weights (bug in logic)")
                );
                *t = new_tensor;

                w_idx += count;
            }
        }

        Ok(())
    }

    /// Mutate weights in-place
    ///
    /// # Arguments
    ///
    /// * `rng` - Random number generator
    /// * `rate` - Probability of mutating each weight (0.0 to 1.0)
    /// * `scale` - Magnitude of mutations
    /// * `strategy` - Mutation algorithm (Additive/Multiplicative/Reset)
    ///
    /// # Algorithm
    ///
    /// For each weight:
    /// ```text
    /// if random() < rate:
    ///     weight = strategy.apply(weight, scale, rng)
    /// ```
    pub(crate) fn mutate(
        &self,
        rng: &mut XorShift,
        rate: f32,
        scale: f32,
        strategy: MutationStrategy,
    ) -> Result<(), JsValue> {
        let mut graph = self.graph.borrow_mut();
        let nodes = graph.nodes_mut();

        for node in nodes.iter_mut() {
            if let gran_prix::graph::Node::Param(ref mut t) = node {
                let cpu = t
                    .as_cpu()
                    .map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
                let mut valid_data = cpu.iter().cloned().collect::<Vec<_>>();
                let shape = t.shape().to_vec();

                for val in valid_data.iter_mut() {
                    if rng.next_f32() < rate {
                        *val = strategy.apply(*val, scale, rng);
                    }
                }

                // SAFETY: Shape matches valid_data length (extracted from same tensor)
                let new_tensor = Tensor::new_cpu(
                    Array::from_shape_vec(IxDyn(&shape), valid_data)
                        .expect("Shape mismatch in mutate (bug in logic)")
                );
                *t = new_tensor;
            }
        }

        Ok(())
    }

    /// Get graph snapshot for visualization
    ///
    /// # Returns
    ///
    /// JavaScript value containing node information and activations
    ///
    /// # Use Case
    ///
    /// Used by UI to display network structure and activation values.
    pub fn get_graph_snapshot(&self) -> JsValue {
        let graph = self.graph.borrow();
        let nodes = graph.nodes();
        let values = graph.values();

        let mut snapshots = Vec::new();
        for (i, node) in nodes.iter().enumerate() {
            let (node_type, name) = match node {
                gran_prix::graph::Node::Input(_) => ("INPUT", "Input Sensors".to_string()),
                gran_prix::graph::Node::Param(_) => ("PARAM", "Weights/Bias".to_string()),
                gran_prix::graph::Node::Op { op, .. } => ("OP", op.name().to_string()),
            };

            let activation = values
                .get(i)
                .and_then(|t: &Option<Tensor>| t.as_ref())
                .and_then(|t: &Tensor| {
                    t.as_cpu()
                        .ok()
                        .map(|v| v.iter().cloned().take(12).collect::<Vec<f32>>())
                });

            snapshots.push(NodeSnapshot {
                id: i,
                node_type,
                name,
                value: activation,
            });
        }

        // SAFETY: NodeSnapshot is Serialize, so this should never fail
        serde_wasm_bindgen::to_value(&snapshots)
            .expect("Failed to serialize graph snapshot (bug in serde)")
    }

    /// Set custom convolution kernel
    ///
    /// # Arguments
    ///
    /// * `k1`, `k2`, `k3` - Kernel values
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use gran_prix_wasm::NeuralBrain;
    /// # let brain = NeuralBrain::new(0, 4, vec![8], 2).unwrap();
    /// brain.set_kernel(-0.5, 1.0, -0.5); // Edge detection
    /// ```
    pub fn set_kernel(&self, k1: f32, k2: f32, k3: f32) {
        let mut kernel = self.custom_kernel.borrow_mut();
        *kernel = vec![k1, k2, k3];
    }
}

/// Graph node snapshot for visualization
///
/// Serialized to JavaScript for UI rendering.
#[derive(Serialize)]
struct NodeSnapshot {
    id: usize,
    #[serde(rename = "type")]
    node_type: &'static str,
    name: String,
    value: Option<Vec<f32>>,
}
