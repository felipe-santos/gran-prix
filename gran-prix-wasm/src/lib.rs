use wasm_bindgen::prelude::*;
use gran_prix::graph::{Graph, dsl::GraphBuilder};
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::Tensor;
use ndarray::Array2;

#[wasm_bindgen]
pub struct NeuralBrain {
    // We can't export generic structs to WASM, so we wrap the concrete type.
    // However, Graph is generic over Backend.
    // We can't put Graph<Box<CPUBackend>> directly in a #[wasm_bindgen] struct field 
    // unless the field is skipped or the type is Copy (it's not).
    // The workaround is to wrap it in a non-wasm-bindgen struct or just accept that it's opaque to JS.
    // Actually, fields of wasm_bindgen struct are not exposed unless pub.
    // But they must strict types if exposed. 
    // We will keep fields private.
    graph: Graph, // Graph defaults to Box<dyn Backend>? No, Graph<B>.
                  // We need to type alias or use concrete type.
                  // But Graph<B> is defined as struct Graph<B: Backend>...
                  // Wait, Graph struct definition: pub struct Graph<B: Backend = Box<dyn Backend>>.
                  // So Graph is Graph<Box<dyn Backend>> by default? 
                  // Let's check src/graph/mod.rs.
    input_node: usize,
    output_node: usize,
}

// Helper to avoid type complexity in struct definition if needed.
// But we should use the concrete type we use.
type BrainGraph = Graph<Box<CPUBackend>>;

#[wasm_bindgen]
impl NeuralBrain {
    #[wasm_bindgen(constructor)]
    pub fn new() -> NeuralBrain {
        console_error_panic_hook::set_once();
        
        // 1. Setup Graph
        let backend = Box::new(CPUBackend);
        let mut graph = BrainGraph::new(backend);
        let mut gb = GraphBuilder::new(&mut graph);

        // 2. Define Architecture (Simple Obstacle Avoider)
        // 5 Sensors -> Hidden(8) -> Output(1: Turn)
        let input_tensor = Tensor::new_zeros(&[1, 5]); // Batch 1, 5 sensors
        let input_node = gb.val(input_tensor);

        // Layer 1
        let w1 = gb.param(Tensor::new_random(&[5, 8]));
        let b1 = gb.param(Tensor::new_zeros(&[1, 8]));
        let l1 = gb.linear(input_node, w1, b1);
        let r1 = gb.relu(l1);

        // Layer 2
        let w2 = gb.param(Tensor::new_random(&[8, 1]));
        let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
        let l2 = gb.linear(r1, w2, b2);
        let output_node = gb.sigmoid(l2);

        NeuralBrain {
            graph,
            input_node: input_node.0,
            output_node: output_node.0,
        }
    }

    pub fn compute(&mut self, sensors: &[f32]) -> f32 {
        // sensors is expected to be length 5
        let input_shape = (1, 5);
        // We need to construct Tensor from slice.
        // ndarray::Array2::from_shape_vec is simplest but takes Vec.
        // from_shape_vec requires ownership.
        // We can copy.
        let data = sensors.to_vec();
        let input_arr = Array2::from_shape_vec(input_shape, data).unwrap();
        let input_tensor: Tensor = input_arr.into_dyn().into();

        // Update Input Node
        if let gran_prix::graph::Node::Input(ref mut t) = self.graph.nodes_mut()[self.input_node] {
             *t = input_tensor;
        }

        self.graph.clear_values();
        let out = self.graph.execute(gran_prix::graph::NodeId(self.output_node)).unwrap();
        
        // Return first element
        *out.view().iter().next().unwrap()
    }

    pub fn train(&mut self, sensors: &[f32], target_turn: f32) -> f32 {
         // Same concept, run backward.
         // ...
         // For now just return prediction.
         let pred = self.compute(sensors);
         
         // Calculate Loss (MSE)
         let diff = pred - target_turn;
         let loss = diff * diff;
         let grad = 2.0 * diff; // Derivative of MSE
         
         // Backward
         // Construct gradient tensor
         let grad_tensor: Tensor = Array2::from_elem((1, 1), grad).into_dyn().into();
         
         self.graph.backward(gran_prix::graph::NodeId(self.output_node), grad_tensor).unwrap();
         self.graph.update_parameters(0.01).unwrap();
         
         loss
    }
}
