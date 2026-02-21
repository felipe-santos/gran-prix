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
    #[allow(dead_code)]
    target_node: RefCell<Option<usize>>,
    input_tensor: RefCell<Tensor>,
}

#[wasm_bindgen]
impl Trainer {
    #[wasm_bindgen(constructor)]
    pub fn new(hidden_size: usize) -> Result<Trainer, JsValue> {
        let backend = Box::new(CPUBackend);
        let mut graph = Graph::new(backend);
        let mut gb = GraphBuilder::new(&mut graph);

        // Input: 2D Point (x, y)
        let input_tensor = Tensor::new_zeros(&[1, 2]);
        let input_id = gb.val(input_tensor);

        // Layer 1: Hidden (Xavier/Glorot Initialization)
        let w1_init = Tensor::new_random(&[2, hidden_size]);
        let mut w1_t = w1_init;
        let scale1 = (6.0 / (2.0 + hidden_size as f32)).sqrt();
        w1_t.as_cpu_mut().unwrap().map_inplace(|v| *v *= scale1);
        let w1 = gb.param(w1_t);
        let b1 = gb.param(Tensor::new_zeros(&[1, hidden_size]));
        let h1 = gb.matmul(input_id, w1);
        let h1 = gb.add(h1, b1);
        let h1 = gb.tanh(h1);

        // Layer 2: Output
        let w2_init = Tensor::new_random(&[hidden_size, 1]);
        let mut w2_t = w2_init;
        let scale2 = (6.0 / (hidden_size as f32 + 1.0)).sqrt();
        w2_t.as_cpu_mut().unwrap().map_inplace(|v| *v *= scale2);
        let w2 = gb.param(w2_t);
        let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
        let out = gb.matmul(h1, w2);
        let out = gb.add(out, b2);
        let final_out = out;

        Ok(Trainer {
            graph: RefCell::new(graph),
            input_node: input_id.0,
            output_node: final_out.0,
            target_node: RefCell::new(None),
            input_tensor: RefCell::new(Tensor::new_zeros(&[1, 2])),
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

    pub fn train_batch(&self, inputs_x: Vec<f32>, inputs_y: Vec<f32>, targets: Vec<f32>, lr: f32) -> Result<f32, JsValue> {
        let mut graph = self.graph.borrow_mut();
        let batch_size = targets.len();
        if batch_size == 0 { return Ok(0.0); }
        
        let mut total_loss = 0.0;
        let target = gran_prix::NodeId(self.output_node);
        let order = graph.topological_sort(target)
            .map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;

        for i in 0..batch_size {
            graph.clear_gradients();
            {
                let mut input_buffer = self.input_tensor.borrow_mut();
                if let Ok(mut view) = input_buffer.try_view_mut() {
                    view[[0, 0]] = inputs_x[i];
                    view[[0, 1]] = inputs_y[i];
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

    pub fn train_step(&self, x: f32, y: f32, target_val: f32, lr: f32) -> Result<f32, JsValue> {
        self.train_batch(vec![x], vec![y], vec![target_val], lr)
    }

    pub fn predict(&self, x: f32, y: f32) -> Result<f32, JsValue> {
        let mut graph = self.graph.borrow_mut();
        {
            let mut input_buffer = self.input_tensor.borrow_mut();
            let mut view = input_buffer.try_view_mut()
                .map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
            view[[0, 0]] = x;
            view[[0, 1]] = y;

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

    pub fn get_decision_boundary(&self, resolution: usize) -> Result<Vec<f32>, JsValue> {
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
                {
                    let mut input_buffer = self.input_tensor.borrow_mut();
                    if let Ok(mut view) = input_buffer.try_view_mut() {
                        view[[0, 0]] = x;
                        view[[0, 1]] = y;
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
