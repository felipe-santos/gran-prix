use wasm_bindgen::prelude::*;
use gran_prix::{Tensor, GPError};
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
    pub fn new(seed_offset: usize) -> Result<NeuralBrain, JsValue> {
        // init_panic_hook(); 
        // console_log!("PRIX: Initializing NeuralBrain...");
        let backend = Box::new(CPUBackend);
        let mut graph = Graph::new(backend);
        let mut gb = GraphBuilder::new(&mut graph);

        let input_tensor = Tensor::new_zeros(&[1, 5]); 
        let input_id = gb.val(input_tensor);

        // Deterministic alternating weights to GUARANTEE steering variance.
        let alternating_tensor = |rows, cols, offset| {
            let total = rows * cols;
            let mut data = Vec::with_capacity(total);
            for i in 0..total {
                let sign = if (i + offset) % 2 == 0 { 1.0 } else { -1.0 };
                data.push(sign * 0.1); 
            }
            Tensor::new_cpu(Array::from_shape_vec(IxDyn(&[rows, cols]), data).unwrap())
        };

        let w1 = gb.param(alternating_tensor(5, 8, seed_offset));
        let b1 = gb.param(Tensor::new_zeros(&[1, 8]));
        let hidden = gb.matmul(input_id, w1);
        let hidden = gb.add(hidden, b1);
        let hidden = gb.relu(hidden);

        let w2 = gb.param(alternating_tensor(8, 1, seed_offset + 10)); 
        let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
        let output = gb.matmul(hidden, w2);
        let output = gb.add(output, b2);
        let final_output = gb.sigmoid(output); 

        // console_log!("PRIX V4-STABLE: Graph built. Input: {}, Output: {}", input_id.0, final_output.0);

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

        // console_log!("PRIX: Graph execution complete.");

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
    pub fn train(&self, _sensors: &[f32], _target: f32) -> Result<(), JsValue> {
         Ok(())
    }

    // Helper for Evolution: Get all weights as flat vector
    pub fn export_weights(&self) -> Result<Vec<f32>, JsValue> {
        let graph = self.graph.borrow();
        let nodes = graph.nodes();
        // Removed values() access as we want the canonical Params
        
        let mut weights = Vec::new();
        
        for node in nodes.iter() {
            if let gran_prix::graph::Node::Param(t) = node {
                 // Param holds the tensor directly
                 let view = t.as_cpu().map_err(|e| JsValue::from_str(&e.to_string()))?;
                 weights.extend(view.iter());
            }
        }
        Ok(weights)
    }

    pub fn import_weights(&self, weights: &[f32]) -> Result<(), JsValue> {
        let mut graph = self.graph.borrow_mut();
        let nodes = graph.nodes_mut();
        
        let mut w_idx = 0;
        
        for node in nodes.iter_mut() {
            if let gran_prix::graph::Node::Param(t) = node {
                 let shape = t.shape().to_vec();
                 let count = t.len();
                 
                 if w_idx + count > weights.len() {
                     return Err(JsValue::from_str("Weights array too short"));
                 }
                 
                 let slice = &weights[w_idx..w_idx+count];
                 let new_tensor = Tensor::new_cpu(Array::from_shape_vec(IxDyn(&shape), slice.to_vec()).unwrap());
                 *t = new_tensor; // Replace the param tensor
                 
                 w_idx += count;
            }
        }
        
        // Critical: Cache values are essentially dirty now.
        // We must clear them to ensure the new params are picked up during next execution
        // because execute() lazily copies Param -> value cache if missing.
        // Since we modified Param, we want execute to re-copy it.
        // But clear_values() might not be enough if it just clears output buffers.
        // Let's check graph.rs: clear_values() does ??? 
        // Actually execute() checks: if self.values[node].is_none() { copy }
        // So we need to set values to None or just clear the vector.
        // graph.clear_values() implementation in graph.rs is empty/placeholder?
        // Let's use graph.clear_gradients() for sure, but for values...
        // We'll inspect clear_values implementation in user file earlier: it was empty!
        // So we need to manually clear values if possible or rely on execute logic?
        // wait, execute says:
        // if self.values[node_id].is_none() { self.values[node_id] = Some(t.clone()) }
        // So if value is PRESENT, it WON'T update from param!
        // We MUST clear the value cache for that param.
        
        // Since we can't easily clear specific values via public API (values is private),
        // we might be in trouble unless we restart the brain or if Graph exposes a way.
        // Graph has `clear_values` but it was empty in the view.
        // Graph has `reset_values`...
        
        // WORKAROUND: For now, Param logic in execute() is:
        // Node::Param(t) => { if self.values[...].is_none() { ... } }
        // So we MUST clear values.
        
        // If I can't clear values, imports won't work immediately.
        // But wait, `NeuralBrain` in `Population::evolve` is created NEW every generation!
        // `let mut offspring = NeuralBrain::new(i)?`
        // So `values` are empty initially!
        // So `import_weights` works fine because it's called on a FRESH brain.
        // The only case it fails is if we import into an EXISTING, run brain.
        // But in evolve() we always create new brains.
        // So we are safe for now.
        
        Ok(())
    }

    fn mutate(&self, rng: &mut XorShift, rate: f32, scale: f32) -> Result<(), JsValue> {
         let mut graph = self.graph.borrow_mut();
         let nodes = graph.nodes_mut();
         
         for node in nodes.iter_mut() {
            if let gran_prix::graph::Node::Param(t) = node {
                 let cpu = t.as_cpu().map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
                 let mut valid_data = cpu.iter().cloned().collect::<Vec<_>>();
                 let shape = t.shape().to_vec();
                 
                 for val in valid_data.iter_mut() {
                     if rng.next_f32() < rate {
                         *val += rng.range(-scale, scale);
                     }
                 }
                 
                 let new_tensor = Tensor::new_cpu(Array::from_shape_vec(IxDyn(&shape), valid_data).unwrap());
                 *t = new_tensor;
            }
        }
        Ok(())
    }
}

// Simple XorShift PRNG for WASM stability
struct XorShift {
    state: u32,
}

impl XorShift {
    fn new(seed: u32) -> Self {
        Self { state: if seed == 0 { 0xDEADBEEF } else { seed } }
    }

    fn next_f32(&mut self) -> f32 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.state = x;
        // Normalize to 0..1
        (x as f32) / (u32::MAX as f32)
    }

    fn range(&mut self, min: f32, max: f32) -> f32 {
        min + (self.next_f32() * (max - min))
    }
}

#[wasm_bindgen]
pub struct Population {
    brains: Vec<NeuralBrain>,
    generation: u32,
    rng: RefCell<XorShift>,
}

#[wasm_bindgen]
impl Population {
    #[wasm_bindgen(constructor)]
    pub fn new(size: usize) -> Result<Population, JsValue> {
        console_log!("PRIX: Initializing Population of size {}", size);
        let mut brains = Vec::with_capacity(size);
        for i in 0..size {
            // Create brain with varied weights based on index
            let mut brain = NeuralBrain::new(i)?; 
            brains.push(brain);
        }
        
        Ok(Population {
            brains,
            generation: 1,
            rng: RefCell::new(XorShift::new(12345)),
        })
    }

    pub fn count(&self) -> usize {
        self.brains.len()
    }

    pub fn compute_all(&self, inputs: &[f32]) -> Result<Vec<f32>, JsValue> {
        // inputs is a flat array: [car0_s1, car0_s2..., car1_s1, ...]
        // verifying length
        if inputs.len() != self.brains.len() * 5 {
             return Err(JsValue::from_str("Input array length mismatch"));
        }

        let mut outputs = Vec::with_capacity(self.brains.len());

        for (i, brain) in self.brains.iter().enumerate() {
            let offset = i * 5;
            let val = brain.compute_internal(
                inputs[offset], 
                inputs[offset+1], 
                inputs[offset+2], 
                inputs[offset+3], 
                inputs[offset+4]
            )?;
            outputs.push(val);
        }

        Ok(outputs)
    }

    pub fn evolve(&mut self, fitness_scores: &[f32]) -> Result<(), JsValue> {
        if fitness_scores.len() != self.brains.len() {
             return Err(JsValue::from_str("Fitness array length mismatch"));
        }

        console_log!("PRIX: Evolving Generation {}...", self.generation);

        // Find best brain
        let mut best_idx = 0;
        let mut best_score = -1.0;
        
        for (i, &score) in fitness_scores.iter().enumerate() {
            if score > best_score {
                best_score = score;
                best_idx = i;
            }
        }

        console_log!("PRIX: Best Brain index: {} with score: {:.2}", best_idx, best_score);

        // Elitism: Keep the best brain exactly as is at index 0
        // We need to clone the graph/weights. 
        // For simplicity in this panic-prone environment, we will RE-CREATE brains
        // using the weights of the winner + mutation.
        
        // Extract weights from best brain (this requires accessing the graph params)
        // Since we don't have easy deep-clone for RefCell<Graph>, we'll use a trick:
        // We know the structure is fixed. We just need the param tensors.
        
        let best_brain = &self.brains[best_idx];
        let best_weights = best_brain.export_weights()?;

        let mut new_brains = Vec::with_capacity(self.brains.len());
        
        // 1. ELITE: First brain is explicit copy of best (no mutation)
        let mut elite = NeuralBrain::new(0)?;
        elite.import_weights(&best_weights)?;
        new_brains.push(elite);

        // 2. OFFSPRING: Rest are mutated copies
        let mut rng = self.rng.borrow_mut();
        
        for i in 1..self.brains.len() {
            let mut offspring = NeuralBrain::new(i)?;
            offspring.import_weights(&best_weights)?;
            offspring.mutate(&mut *rng, 0.2, 0.5)?; // rate 0.2, scale 0.5
            new_brains.push(offspring);
        }

        self.brains = new_brains;
        self.generation += 1;
        console_log!("PRIX: Generation {} ready.", self.generation);

        Ok(())
    }
}
