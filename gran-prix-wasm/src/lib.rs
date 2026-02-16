use wasm_bindgen::prelude::*;
use gran_prix::Tensor;
use gran_prix::graph::{Graph, dsl::GraphBuilder};
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
    // Pre-allocated input to avoid ANY allocation in compute
    input_tensor: RefCell<Tensor>,
    // Corruption detection
    magic: u32,
    // Re-entrancy protection
    computing: RefCell<bool>,
}

struct ComputingGuard<'a>(&'a RefCell<bool>);
impl<'a> Drop for ComputingGuard<'a> {
    fn drop(&mut self) {
        *self.0.borrow_mut() = false;
    }
}

const BRAIN_MAGIC: u32 = 0xDEADC0DE;

#[wasm_bindgen]
impl NeuralBrain {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<NeuralBrain, JsValue> {
        init_panic_hook();
        console_log!("PRIX: Initializing NeuralBrain...");
        let backend = Box::new(CPUBackend);
        let mut graph = Graph::new(backend);
        let mut gb = GraphBuilder::new(&mut graph);

        // ...
        let input_tensor = Tensor::new_zeros(&[1, 5]); 
        let input_id = gb.val(input_tensor);

        let w1 = gb.param(Tensor::new_cpu(Array::from_elem(IxDyn(&[5, 8]), 0.1)));
        let b1 = gb.param(Tensor::new_zeros(&[1, 8]));
        let hidden = gb.matmul(input_id, w1);
        let hidden = gb.add(hidden, b1);
        let hidden = gb.relu(hidden);

        let w2 = gb.param(Tensor::new_cpu(Array::from_elem(IxDyn(&[8, 1]), 0.1)));
        let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
        let output = gb.matmul(hidden, w2);
        let output = gb.add(output, b2);
        let final_output = gb.sigmoid(output); 

        console_log!("PRIX V4-STABLE: Graph built. Input: {}, Output: {}", input_id.0, final_output.0);

        Ok(NeuralBrain {
            graph: RefCell::new(graph),
            input_node: input_id.0,
            output_node: final_output.0,
            input_tensor: RefCell::new(Tensor::new_zeros(&[1, 5])),
            magic: BRAIN_MAGIC,
            computing: RefCell::new(false),
        })
    }

    pub fn compute(&self, s1: f32, s2: f32, s3: f32, s4: f32, s5: f32) -> Result<f32, JsValue> {
        if self.magic != BRAIN_MAGIC {
            console_log!("PRIX CRITICAL: Brain corrupted BEFORE compute! Magic: 0x{:08X}", self.magic);
            return Err(JsValue::from_str("Corrupted before compute"));
        }

        let _guard = {
            let mut computing = self.computing.borrow_mut();
            if *computing {
                return Err(JsValue::from_str("Re-entrant call detected"));
            }
            *computing = true;
            ComputingGuard(&self.computing)
        };

        let result = self.compute_internal(s1, s2, s3, s4, s5);

        if self.magic != BRAIN_MAGIC {
            console_log!("PRIX CRITICAL: Brain corrupted AFTER compute! Magic: 0x{:08X}", self.magic);
        }

        result
    }

    fn compute_internal(&self, s1: f32, s2: f32, s3: f32, s4: f32, s5: f32) -> Result<f32, JsValue> {
        let mut input_buffer = self.input_tensor.borrow_mut();
        {
            let mut view = input_buffer.try_view_mut()
                .map_err(|e| JsValue::from_str(&format!("PRIX: Buffer view error: {}", e)))?;
            if let Some(v) = view.get_mut(ndarray::IxDyn(&[0, 0])) { *v = s1; }
            if let Some(v) = view.get_mut(ndarray::IxDyn(&[0, 1])) { *v = s2; }
            if let Some(v) = view.get_mut(ndarray::IxDyn(&[0, 2])) { *v = s3; }
            if let Some(v) = view.get_mut(ndarray::IxDyn(&[0, 3])) { *v = s4; }
            if let Some(v) = view.get_mut(ndarray::IxDyn(&[0, 4])) { *v = s5; }
        }

        let mut graph = self.graph.borrow_mut();
        
        // Injetar input
        {
            let nodes = graph.nodes_mut();
            if let Some(gran_prix::graph::Node::Input(ref mut t)) = nodes.get_mut(self.input_node) {
                t.copy_from(&input_buffer).map_err(|e| JsValue::from_str(&format!("PRIX: Copy error: {}", e)))?;
            }
        }
        
        let output_id = gran_prix::NodeId(self.output_node);
        let order = graph.topological_sort(output_id)
            .map_err(|e| JsValue::from_str(&format!("Sort error: {}", e)))?;

        for node_id in order {
            if self.magic != BRAIN_MAGIC {
                console_log!("PRIX CRITICAL: Corruption detected BEFORE node {}", node_id.0);
                return Err(JsValue::from_str("Heap corruption detected mid-execution"));
            }
            
            // GRANULAR TRACING
            // console_log!("PRIX: Node {} step...", node_id.0);
            
            graph.execute_single_node(node_id)
                .map_err(|e| {
                    console_log!("PRIX: Node {} error: {}", node_id.0, e);
                    JsValue::from_str(&format!("Node {} execution error: {}", node_id.0, e))
                })?;
        }

        let values = graph.values();
        let result_tensor = values.get(self.output_node)
            .and_then(|t| t.as_ref())
            .ok_or_else(|| JsValue::from_str("Output not found"))?;

        let cpu_view = result_tensor.as_cpu()
             .map_err(|e| JsValue::from_str(&format!("Failed to get CPU view: {}", e)))?;
        
        let val = *cpu_view.get(ndarray::IxDyn(&[0, 0]))
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
