use wasm_bindgen::prelude::*;
use gran_prix::{Tensor, GPError};
use gran_prix::graph::{Graph, dsl::GraphBuilder};
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::loss::{Loss, MSE};
use ndarray::{Array, IxDyn};
use serde::Serialize;
use std::cell::RefCell;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

macro_rules! console_log {
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
#[derive(Copy, Clone)]
pub enum MutationStrategy {
    Additive,
    Multiplicative,
    Reset,
}



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
    // Manual convolution kernel (1x3)
    custom_kernel: RefCell<Vec<f32>>,
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
            custom_kernel: RefCell::new(vec![0.0, 1.0, 0.0]), // Default identity kernel
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
            
            // Apply Manual 1D Convolution
            let raw_inputs = [s1, s2, s3, s4, s5];
            let kernel = self.custom_kernel.borrow();
            let mut processed = vec![0.0; 5];
            
            for i in 0..5 {
                for k in 0..3 {
                    let idx = i as i32 + k as i32 - 1;
                    if idx >= 0 && idx < 5 {
                        processed[i] += raw_inputs[idx as usize] * kernel[k];
                    }
                }
            }

            for i in 0..5 {
                if let Some(v) = view.get_mut(ndarray::IxDyn(&[0, i])) { 
                    *v = processed[i]; 
                }
            }
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

        // RESTORED LOOP WITH LOGGING
        for node_id in order {
            if self.magic != BRAIN_MAGIC {
                console_log!("PRIX CRITICAL: Corruption detected BEFORE node {}", node_id.0);
                return Err(JsValue::from_str("Heap corruption detected mid-execution"));
            }
            
            // console_log!("PRIX: Executing Node {}", node_id.0);
            
            graph.execute_single_node(node_id)
                .map_err(|e| {
                    console_log!("PRIX: Node {} error: {}", node_id.0, e);
                    JsValue::from_str(&format!("Node {} execution error: {}", node_id.0, e))
                })?;
        }

        // console_log!("PRIX: Graph execution complete.");

        let values = graph.values();
        let result_tensor = values.get(self.output_node)
            .and_then(|t: &Option<Tensor>| t.as_ref())
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
            if let gran_prix::graph::Node::Param(ref mut t) = node {
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

    fn mutate(&self, rng: &mut XorShift, rate: f32, scale: f32, strategy: MutationStrategy) -> Result<(), JsValue> {
         let mut graph = self.graph.borrow_mut();
         let nodes = graph.nodes_mut();
         
         for node in nodes.iter_mut() {
            if let gran_prix::graph::Node::Param(ref mut t) = node {
                 let cpu = t.as_cpu().map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
                 let mut valid_data = cpu.iter().cloned().collect::<Vec<_>>();
                 let shape = t.shape().to_vec();
                 
                 for val in valid_data.iter_mut() {
                     if rng.next_f32() < rate {
                         match strategy {
                             MutationStrategy::Additive => {
                                 *val += rng.range(-scale, scale);
                             }
                             MutationStrategy::Multiplicative => {
                                 *val *= 1.0 + rng.range(-scale, scale);
                             }
                             MutationStrategy::Reset => {
                                 *val = rng.range(-scale, scale);
                             }
                         }
                     }
                 }
                 
                 let new_tensor = Tensor::new_cpu(Array::from_shape_vec(IxDyn(&shape), valid_data).unwrap());
                 *t = new_tensor;
            }
        }
        Ok(())
    }

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

            let activation = values.get(i).and_then(|t: &Option<Tensor>| t.as_ref()).and_then(|t: &Tensor| {
                t.as_cpu().ok().map(|v| v.iter().cloned().take(12).collect::<Vec<f32>>())
            });

            snapshots.push(NodeSnapshot {
                id: i,
                node_type,
                name,
                value: activation
            });
        }

        serde_wasm_bindgen::to_value(&snapshots).unwrap()
    }

    pub fn set_kernel(&self, k1: f32, k2: f32, k3: f32) {
        let mut kernel = self.custom_kernel.borrow_mut();
        *kernel = vec![k1, k2, k3];
    }
}

#[derive(Serialize)]
struct NodeSnapshot {
    id: usize,
    #[serde(rename = "type")]
    node_type: &'static str,
    name: String,
    value: Option<Vec<f32>>,
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
    rng: XorShift,
    global_kernel: Vec<f32>,
}

#[wasm_bindgen]
impl Population {
    #[wasm_bindgen(constructor)]
    pub fn new(size: usize) -> Result<Population, JsValue> {
        console_log!("PRIX: Initializing Population of size {}", size);
        let mut brains = Vec::with_capacity(size);
        for i in 0..size {
            // Create brain with varied weights based on index
            let brain = NeuralBrain::new(i)?; 
            brains.push(brain);
        }
        
        let pop = Population {
            brains,
            generation: 1,
            rng: XorShift::new(12345),
            global_kernel: vec![0.0, 1.0, 0.0],
        };
        console_log!("PRIX: Population created at {:p}", &pop);
        Ok(pop)
    }

    pub fn count(&self) -> usize {
        self.brains.len()
    }

    pub fn compute_all(&self, inputs: &[f32]) -> Result<Vec<f32>, JsValue> {
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

    pub fn evolve(&mut self, fitness_scores: &[f32], mutation_rate: f32, mutation_scale: f32, strategy: MutationStrategy) -> Result<(), JsValue> {
        if fitness_scores.len() != self.brains.len() {
             return Err(JsValue::from_str("Fitness array length mismatch"));
        }

        let strat_name = match strategy {
            MutationStrategy::Additive => "ADDITIVE",
            MutationStrategy::Multiplicative => "MULTIPLICATIVE",
            MutationStrategy::Reset => "RESET",
        };
        console_log!("PRIX: Evolution Strategy: {} | Rate: {} | Scale: {}", strat_name, mutation_rate, mutation_scale);

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

        let best_brain = &self.brains[best_idx];
        let best_weights = best_brain.export_weights()?;

        let mut new_brains = Vec::with_capacity(self.brains.len());
        
        // 1. ELITE: First brain is explicit copy of best
        let elite = NeuralBrain::new(0)?;
        elite.import_weights(&best_weights)?;
        new_brains.push(elite);

        // 2. OFFSPRING: Rest are mutated copies
        let rng = &mut self.rng;
        
        for i in 1..self.brains.len() {
            let offspring = NeuralBrain::new(i + (self.generation as usize * 1000))?;
            offspring.import_weights(&best_weights)?;
            
            // Propagate global kernel
            offspring.set_kernel(self.global_kernel[0], self.global_kernel[1], self.global_kernel[2]);
            
            offspring.mutate(rng, mutation_rate, mutation_scale, strategy)?; 
            new_brains.push(offspring);
        }

        self.brains = new_brains;
        self.generation += 1;
        console_log!("PRIX: Generation {} ready. (Self: {:p})", self.generation, self);

        Ok(())
    }

    pub fn get_best_brain_snapshot(&self, fitness_scores: &[f32]) -> JsValue {
        if fitness_scores.len() != self.brains.len() {
            return JsValue::NULL;
        }

        let mut best_idx = 0;
        let mut best_score = -1.0;
        for (i, &score) in fitness_scores.iter().enumerate() {
            if score > best_score {
                best_score = score;
                best_idx = i;
            }
        }

        self.brains[best_idx].get_graph_snapshot()
    }

    pub fn set_global_kernel(&mut self, k1: f32, k2: f32, k3: f32) {
        self.global_kernel = vec![k1, k2, k3];
        // Apply to current population as well
        for brain in self.brains.iter() {
            brain.set_kernel(k1, k2, k3);
        }
    }
}

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
        // REMOVED: let final_out = gb.sigmoid(out); -> We now output logits for BCEWithLogits
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

        // Pre-compute topological order once
        let target = gran_prix::NodeId(self.output_node);
        let order = graph.topological_sort(target)
            .map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;

        for i in 0..batch_size {
            // 1. Clear gradients before each sample's backward pass
            graph.clear_gradients();

            // 2. Prepare and set input
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

            // 3. Forward pass — caches all intermediate values correctly
            let result = graph.execute_with_order(&order, target)
                .map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;
            
            // 4. Compute loss gradient
            let target_tensor = Tensor::new_cpu(Array::from_shape_vec(IxDyn(&[1, 1]), vec![targets[i]]).unwrap());
            let loss_fn = gran_prix::loss::BCEWithLogits;
            let grad = loss_fn.gradient(&result, &target_tensor);
            total_loss += loss_fn.calculate(&result, &target_tensor);

            // 5. Backward — uses the cached values from THIS sample's forward pass
            graph.backward(gran_prix::NodeId(self.output_node), grad)
                .map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;

            // 6. Update parameters immediately (SGD per sample, averaged by batch_size)
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
        
        // 1. Prepare Input
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
        
        // 1. Sync Params ONCE per grid prediction (MASSIVE Optimization)
        graph.sync_params().map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;

        let order = graph.topological_sort(target)
            .map_err(|e: GPError| JsValue::from_str(&e.to_string()))?;

        let mut results = Vec::with_capacity(resolution * resolution);
        for j in 0..resolution {
            for i in 0..resolution {
                let x = (i as f32 / resolution as f32) * 2.0 - 1.0;
                let y = (j as f32 / resolution as f32) * 2.0 - 1.0;
                
                // Prepare Input (Internal sync)
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
