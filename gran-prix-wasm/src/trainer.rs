//! Online Trainer for Supervised Learning in WASM
//!
//! This module implements a `Trainer` that uses backpropagation to train
//! neural networks on the fly. 

use wasm_bindgen::prelude::*;
use std::cell::RefCell;
use gran_prix::{Tensor, GPError};
use gran_prix::graph::{Graph, dsl::GraphBuilder};
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::loss::Loss;
use ndarray::{Array, IxDyn};

#[wasm_bindgen]
pub struct Trainer {
    graph: RefCell<Graph>,
    input_node: usize,
    output_node: usize,
    input_dim: usize,
    #[allow(dead_code)]
    target_node: RefCell<Option<usize>>,
    input_tensor: RefCell<Tensor>,
}

#[wasm_bindgen]
impl Trainer {
    #[wasm_bindgen(constructor)]
    pub fn new(input_dim: usize, hidden_layers: Vec<usize>) -> Result<Trainer, JsValue> {
        let backend = Box::new(CPUBackend);
        let mut graph = Graph::new(backend);
        let mut gb = GraphBuilder::new(&mut graph);

        // Input: Expandable according to features
        let input_tensor = Tensor::new_zeros(&[1, input_dim]);
        let input_id = gb.val(input_tensor);

        let mut current_size = input_dim;
        let mut last_node = input_id;

        // Build Hidden Layers dynamically
        for &hidden_size in hidden_layers.iter() {
            let w_init = Tensor::new_random(&[current_size, hidden_size]);
            let mut w_t = w_init;
            let scale = (6.0 / (current_size as f32 + hidden_size as f32)).sqrt();
            w_t.as_cpu_mut().unwrap().map_inplace(|v| *v *= scale);
            
            let w = gb.param(w_t);
            let b = gb.param(Tensor::new_zeros(&[1, hidden_size]));
            
            let h = gb.matmul(last_node, w);
            let h = gb.add(h, b);
            last_node = gb.tanh(h);
            
            current_size = hidden_size;
        }

        // Final Output Layer (1 neuron)
        let w_out_init = Tensor::new_random(&[current_size, 1]);
        let mut w_out_t = w_out_init;
        let scale_out = (6.0 / (current_size as f32 + 1.0)).sqrt();
        w_out_t.as_cpu_mut().unwrap().map_inplace(|v| *v *= scale_out);
        
        let w_out = gb.param(w_out_t);
        let b_out = gb.param(Tensor::new_zeros(&[1, 1]));
        
        let out = gb.matmul(last_node, w_out);
        let final_out = gb.add(out, b_out);

        Ok(Trainer {
            graph: RefCell::new(graph),
            input_node: input_id.0,
            output_node: final_out.0,
            input_dim,
            target_node: RefCell::new(None),
            input_tensor: RefCell::new(Tensor::new_zeros(&[1, input_dim])),
        })
    }

    pub fn get_weights(&self) -> Result<Vec<f32>, JsValue> {
        let graph = self.graph.borrow();
        let mut weights = Vec::new();
        for node in graph.nodes() {
            if let gran_prix::graph::Node::Param(t) = node {
                let view = t.as_cpu().map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
                weights.extend(view.iter());
            }
        }
        Ok(weights)
    }

    /// Diagnostic: Returns the sum of absolute gradients for each parameter node.
    /// Used to verify that backprop is reaching all layers.
    pub fn get_gradient_norms(&self) -> Result<Vec<f32>, JsValue> {
        let graph = self.graph.borrow();
        let mut norms = Vec::new();
        for i in 0..graph.nodes().len() {
            if let gran_prix::graph::Node::Param(_) = &graph.nodes()[i] {
                if let Some(grad) = graph.get_gradient(gran_prix::NodeId(i)) {
                    let view = grad.as_cpu().map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
                    let sum_abs: f32 = view.iter().map(|x| x.abs()).sum();
                    norms.push(sum_abs);
                } else {
                    norms.push(0.0);
                }
            }
        }
        Ok(norms)
    }

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
                        .map_err(|e| JsValue::from_str(&e.to_string()))?
                );
                *t = new_tensor;

                w_idx += count;
            }
        }

        Ok(())
    }

    pub fn train_batch(&self, inputs: Vec<f32>, targets: Vec<f32>, lr: f32) -> Result<f32, JsValue> {
        let mut graph = self.graph.borrow_mut();
        
        let batch_size = targets.len();
        if batch_size == 0 { return Ok(0.0); }
        if inputs.len() != batch_size * self.input_dim {
            return Err(JsValue::from_str("Input vector size mismatch"));
        }
        
        let mut total_loss = 0.0;
        let target = gran_prix::NodeId(self.output_node);
        let order = graph.topological_sort(target)
            .map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;

        for i in 0..batch_size {
            graph.clear_gradients();
            {
                let mut input_buffer = self.input_tensor.borrow_mut();
                if let Ok(mut view) = input_buffer.try_view_mut() {
                    let start = i * self.input_dim;
                    for d in 0..self.input_dim {
                        view[[0, d]] = inputs[start + d];
                    }
                }
                if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(self.input_node) {
                    t.copy_from(&input_buffer).map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
                }
            }

            let result = graph.execute_with_order(&order, target)
                .map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
            
            let target_tensor = Tensor::new_cpu(Array::from_shape_vec(IxDyn(&[1, 1]), vec![targets[i]]).unwrap());
            let loss_fn = gran_prix::loss::BCEWithLogits;
            let grad = loss_fn.gradient(&result, &target_tensor);
            total_loss += loss_fn.calculate(&result, &target_tensor);

            graph.backward(gran_prix::NodeId(self.output_node), grad)
                .map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;

            graph.update_parameters(lr / batch_size as f32)
                .map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
        }

        Ok(total_loss / batch_size as f32)
    }

    pub fn train_step(&self, features: Vec<f32>, target_val: f32, lr: f32) -> Result<f32, JsValue> {
        self.train_batch(features, vec![target_val], lr)
    }

    pub fn predict(&self, features: Vec<f32>) -> Result<f32, JsValue> {
        if features.len() != self.input_dim {
            return Err(JsValue::from_str("Features dimension mismatch"));
        }
        let mut graph = self.graph.borrow_mut();
        {
            let mut input_buffer = self.input_tensor.borrow_mut();
            let mut view = input_buffer.try_view_mut()
                .map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
            
            for d in 0..self.input_dim {
                view[[0, d]] = features[d];
            }

            if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(self.input_node) {
                t.copy_from(&input_buffer).map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
            }
        }

        let result = graph.execute(gran_prix::NodeId(self.output_node))
            .map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
        
        let view = result.as_cpu().map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
        let logit = view[[0, 0]];
        Ok(1.0 / (1.0 + (-logit).exp()))
    }

    pub fn get_decision_boundary(&self, resolution: usize, feature_map: js_sys::Function) -> Result<Vec<f32>, JsValue> {
        let mut graph = self.graph.borrow_mut();
        let target = gran_prix::NodeId(self.output_node);
        graph.sync_params().map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;

        let order = graph.topological_sort(target)
            .map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;

        let mut results = Vec::with_capacity(resolution * resolution);
        for j in 0..resolution {
            for i in 0..resolution {
                let x = (i as f32 / resolution as f32) * 2.0 - 1.0;
                let y = (j as f32 / resolution as f32) * 2.0 - 1.0;
                
                // Call JS function to map (x, y) to expanded feature vector
                let js_x = JsValue::from_f64(x as f64);
                let js_y = JsValue::from_f64(y as f64);
                let expanded = feature_map.call2(&JsValue::NULL, &js_x, &js_y)?
                    .dyn_into::<js_sys::Float32Array>()?;
                let features = expanded.to_vec();

                {
                    let mut input_buffer = self.input_tensor.borrow_mut();
                    if let Ok(mut view) = input_buffer.try_view_mut() {
                        for d in 0..self.input_dim {
                            view[[0, d]] = features[d];
                        }
                    }
                    if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(self.input_node) {
                        t.copy_from(&input_buffer).map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
                    }
                }

                let result = graph.execute_with_order(&order, target)
                    .map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
                let view = result.as_cpu().map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
                let logit = view[[0, 0]];
                results.push(1.0 / (1.0 + (-logit).exp()));
            }
        }
        Ok(results)
    }
}
