use gran_prix::graph::{Graph, dsl::GraphBuilder};
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::loss::{Loss, MSE};
use gran_prix::Tensor;
use ndarray::array;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("📖 Braille Challenge: Learning characters from dots (Graph API)");

    // 1. Data
    // 6 inputs (dots) -> 1 output (char index)
    let inputs_data: Tensor = array![
        [0.0, 0.0, 0.0, 0.0, 0.0, 0.0], // (space) -> 0
        [0.0, 1.0, 1.0, 1.0, 0.0, 1.0], // the -> 29
        [0.0, 0.0, 0.0, 0.0, 1.0, 0.0], // (contraction) -> 2
        [1.0, 0.0, 0.0, 0.0, 0.0, 0.0], // a -> 32
        [1.0, 1.0, 0.0, 0.0, 0.0, 0.0]  // b -> 48
    ].into_dyn().into();
    
    // Normalize targets to 0-1 range for Sigmoid, or remove Sigmoid.
    // Let's remove Sigmoid on output for regression.
    let targets_data: Tensor = array![[0.0], [29.0], [2.0], [32.0], [48.0]].into_dyn().into();

    // 2. Setup Graph
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    
    let input_node = graph.input(Tensor::new_zeros(&[5, 6]));
    
    let mut gb = GraphBuilder::new(&mut graph);
    
    // Layer 1: 6 -> 12
    let w1 = gb.param(Tensor::new_random(&[6, 12]));
    let b1 = gb.param(Tensor::new_zeros(&[1, 12]));
    let l1 = gb.linear(input_node, w1, b1);
    let r1 = gb.sigmoid(l1); // Using Sigmoid as per original example for hidden layer
    
    // Layer 2: 12 -> 1
    let w2 = gb.param(Tensor::new_random(&[12, 1]));
    let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
    let output_node = gb.linear(r1, w2, b2);
    // Removed final Sigmoid because targets are > 1.
    
    let loss_fn = MSE;
    let learning_rate = 0.01; // Lower LR for regression with large values

    // 3. Training Loop
    println!("Starting training...");
    for epoch in 0..5001 { // Reduced epochs for demo, original was 20000
        
        // Load data
        if let gran_prix::graph::Node::Input(ref mut t) = graph.nodes_mut()[input_node.0] {
             *t = inputs_data.clone();
        }

        // Forward
        let prediction = graph.execute(output_node)?;
        
        // Loss
        let loss = loss_fn.calculate(&prediction, &targets_data);
        
        // Backward
        let gradient = loss_fn.gradient(&prediction, &targets_data);
        graph.backward(output_node, gradient)?;
        
        // Update
        graph.update_parameters(learning_rate)?;
        
        // Clear
        graph.clear_values();
        graph.clear_gradients();
        
        if epoch % 1000 == 0 {
            println!("Epoch {}: Loss = {:.6}", epoch, loss);
        }
    }

    // 4. Verification
    println!("\nFinal Results (Predicted vs Target):");
    
    // Load data
    if let gran_prix::graph::Node::Input(ref mut t) = graph.nodes_mut()[input_node.0] {
             *t = inputs_data.clone();
    }
    
    let final_output = graph.execute(output_node)?;
    
    for i in 0..5 {
        println!("Pattern {:?} | Expected: {:.2} | Predicted: {:.4}", 
            i, targets_data.view()[[i, 0]], final_output.view()[[i, 0]]);
    }
    
    Ok(())
}
