use wasm_bindgen::prelude::*;
use gran_prix::{Tensor, TensorOps};
use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use ndarray::{Array, IxDyn};

// Turn on console_error_panic_hook for better error messages in the browser
#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct NeuralBrain {
    graph: Graph,
    input_node: usize,  // Store as usize to avoid visibility issues with NodeId
    output_node: usize,
}

#[wasm_bindgen]
impl NeuralBrain {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<NeuralBrain, JsValue> {
        let backend = Box::new(CPUBackend);
        let mut graph = Graph::new(backend);
        let mut gb = GraphBuilder::new(&mut graph);

        // Define a simple architecture: 5 inputs -> 8 hidden -> 1 output
        // Input: 5 sensors (raycasts)
        // Hidden: 8 neurons
        // Output: 1 steering value (-1.0 to 1.0)

        // 1. Input Layer
        // We create a placeholder tensor for shape inference.
        // In real execution, we'll feed actual data.
        let input_tensor = Tensor::new_zeros(&[1, 5]); 
        let input_id = gb.val(input_tensor); // Use val() for inputs/values

        // 2. Hidden Layer (Linear + ReLU)
        // Weights: [5, 8] (5 inputs, 8 outputs)
        let w1 = gb.param(Tensor::new_random(&[5, 8]));
        let b1 = gb.param(Tensor::new_zeros(&[1, 8]));
        
        let hidden = gb.matmul(input_id, w1);
        let hidden = gb.add(hidden, b1);
        let hidden = gb.relu(hidden);

        // 3. Output Layer (Linear + Tanh for steering? Or just Linear restricted?)
        // Let's use Tanh for -1 to 1 range, or just Linear.
        // For this demo, let's output a single value.
        let w2 = gb.param(Tensor::new_random(&[8, 1]));
        let b2 = gb.param(Tensor::new_zeros(&[1, 1]));

        let output = gb.matmul(hidden, w2);
        let output = gb.add(output, b2);
        let final_output = gb.sigmoid(output); // 0.0 to 1.0 steering (0.5 is straight)

        Ok(NeuralBrain {
            graph,
            input_node: input_id.0,
            output_node: final_output.0,
        })
    }

    /// Forward pass: Takes an array of sensor values and returns steering (0.0 to 1.0)
    pub fn compute(&mut self, sensors: &[f32]) -> Result<f32, JsValue> {
        if sensors.len() != 5 {
            return Err(JsValue::from_str("Expected 5 sensor inputs"));
        }

        // Convert input slice to Tensor via ndarray
        let array = Array::from_shape_vec(IxDyn(&[1, 5]), sensors.to_vec())
            .map_err(|e| JsValue::from_str(&format!("Tensor create error: {}", e)))?;
        let input_tensor = Tensor::new_cpu(array);

        // We need to inject this input into the graph.
        {
            let nodes = self.graph.nodes_mut();
            if let Some(gran_prix::graph::Node::Input(ref mut t)) = nodes.get_mut(self.input_node) {
                *t = input_tensor;
            } else {
                 return Err(JsValue::from_str("Input node not found"));
            }
        }
        
        // We MUST clear the values cache to ensure re-execution
        self.graph.clear_values();

        let output_id = gran_prix::NodeId(self.output_node);
        let result = self.graph.execute(output_id)
             .map_err(|e| JsValue::from_str(&format!("Graph execution error: {}", e)))?;

        // Extract single f32
        // result is [1, 1]
        // result.as_cpu() returns GPResult<&ArrayD<f32>>
        let cpu_view = result.as_cpu()
             .map_err(|e| JsValue::from_str(&format!("Failed to get CPU view: {}", e)))?;
        
        let val = *cpu_view.get(IxDyn(&[0, 0]))
             .ok_or_else(|| JsValue::from_str("Failed to get result value"))?;
        
        Ok(val)
    }

    pub fn reset(&mut self) {
        self.graph.clear_values();
        self.graph.clear_gradients();
    }
    
    // Simple training step (reinforcement signal)
    // For this demo, let's say we just want to push the output towards a target
    pub fn train(&mut self, sensors: &[f32], target: f32) -> Result<(), JsValue> {
         // 1. Forward (to populate values)
         let _pred = self.compute(sensors)?;
         
         // 2. Compute Loss Gradient (MSE)
         // Loss = 0.5 * (pred - target)^2
         // dLoss/dPred = (pred - target)
         
         // We need the prediction tensor.
         let output_id = gran_prix::NodeId(self.output_node);
         
         // Access prediction
         let pred_tensor = self.graph.execute(output_id)
            .map_err(|e| JsValue::from_str(&format!("Exec error: {}", e)))?;
         
         let cpu_view = pred_tensor.as_cpu()
            .map_err(|e| JsValue::from_str(&format!("Failed to get CPU view: {}", e)))?;

         let pred_val = *cpu_view.get(IxDyn(&[0, 0])).unwrap();
         let grad_val = pred_val - target;
         
         let grad_array = Array::from_elem(IxDyn(pred_tensor.shape()), grad_val);
         let grad_tensor = Tensor::new_cpu(grad_array);
         
         // 3. Backward
         self.graph.clear_gradients();
         self.graph.backward(gran_prix::NodeId(self.output_node), grad_tensor)
             .map_err(|e| JsValue::from_str(&format!("Backward error: {}", e)))?;
             
         // 4. Update
         self.graph.update_parameters(0.01)
             .map_err(|e| JsValue::from_str(&format!("Update error: {}", e)))?;
             
         Ok(())
    }
}
