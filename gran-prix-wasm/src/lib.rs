use wasm_bindgen::prelude::*;
use gran_prix::{Tensor, TensorOps};
use gran_prix::graph::{Graph, OpType, dsl::GraphBuilder};
use gran_prix::backend::cpu::CPUBackend;
use ndarray::{Array, IxDyn};

// Turn on console_error_panic_hook for better error messages in the browser
#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

macro_rules! console_log {
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

use std::cell::RefCell;

#[wasm_bindgen]
pub struct NeuralBrain {
    graph: RefCell<Graph>,
    input_node: usize,
    output_node: usize,
}

#[wasm_bindgen]
impl NeuralBrain {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<NeuralBrain, JsValue> {
        let backend = Box::new(CPUBackend);
        let mut graph = Graph::new(backend);
        let mut gb = GraphBuilder::new(&mut graph);

        // FULL ARCHITECTURE RESTORED
        // 1. Input Layer
        let input_tensor = Tensor::new_zeros(&[1, 5]); 
        let input_id = gb.val(input_tensor);

        // 2. Hidden Layer (Linear + ReLU)
        let w1 = gb.param(Tensor::new_cpu(Array::from_elem(IxDyn(&[5, 8]), 0.1)));
        let b1 = gb.param(Tensor::new_zeros(&[1, 8]));
        
        let hidden = gb.matmul(input_id, w1);
        let hidden = gb.add(hidden, b1);
        let hidden = gb.relu(hidden);

        // 3. Output Layer (Linear + Sigmoid)
        let w2 = gb.param(Tensor::new_cpu(Array::from_elem(IxDyn(&[8, 1]), 0.1)));
        let b2 = gb.param(Tensor::new_zeros(&[1, 1]));

        let output = gb.matmul(hidden, w2);
        let output = gb.add(output, b2);
        let final_output = gb.sigmoid(output); 

        Ok(NeuralBrain {
            graph: RefCell::new(graph),
            input_node: input_id.0,
            output_node: final_output.0,
        })
    }

    /// Forward pass: Takes 5 sensor values manually to avoid array passing issues
    pub fn compute(&self, s1: f32, s2: f32, s3: f32, s4: f32, s5: f32) -> Result<f32, JsValue> {
        // console_log!("Compute start: {}, {}, ...", s1, s2);

        // Convert input slice to Tensor via ndarray
        let vec_data = vec![s1, s2, s3, s4, s5];
        let array = Array::from_shape_vec(IxDyn(&[1, 5]), vec_data)
            .map_err(|e| JsValue::from_str(&format!("Tensor create error: {}", e)))?;
        let input_tensor = Tensor::new_cpu(array);

        // Debug scope for RefCell
        let mut graph = match self.graph.try_borrow_mut() {
             Ok(g) => g,
             Err(_) => {
                 // In JS, this happens if a frame takes too long and the next one starts.
                 // We return an error to JS so it can skip this frame.
                 return Err(JsValue::from_str("Graph is busy (re-entrancy detected)"));
             }
        };

        // Inject Input
        {
            let nodes = graph.nodes_mut();
            if let Some(gran_prix::graph::Node::Input(ref mut t)) = nodes.get_mut(self.input_node) {
                *t = input_tensor;
            } else {
                 return Err(JsValue::from_str("Input node not found"));
            }
        }
        
        graph.clear_values();

        let output_id = gran_prix::NodeId(self.output_node);
        // console_log!("Executing graph...");
        let result = graph.execute(output_id)
             .map_err(|e| {
                 console_log!("Graph execution error: {}", e);
                 JsValue::from_str(&format!("Graph execution error: {}", e))
             })?;

        // Extract single f32
        let cpu_view = result.as_cpu()
             .map_err(|e| JsValue::from_str(&format!("Failed to get CPU view: {}", e)))?;
        
        let val = *cpu_view.get(IxDyn(&[0, 0]))
             .ok_or_else(|| JsValue::from_str("Failed to get result value"))?;
        
        Ok(val)
    }

    pub fn reset(&self) {
        let mut graph = self.graph.borrow_mut();
        graph.clear_values();
        graph.clear_gradients();
    }
    
    // Simple training step (reinforcement signal)
    pub fn train(&self, sensors: &[f32], target: f32) -> Result<(), JsValue> {
         // Re-implement if needed, but for now just skip to get demo running smoothly
         // or implement with borrow_mut()
         Ok(())
    }
}
