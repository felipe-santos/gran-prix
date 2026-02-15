use gran_prix::graph::{Graph, dsl::GraphBuilder};
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::loss::{Loss, MSE};
use gran_prix::Tensor;
use gran_prix::tensor::TensorOps;
use ndarray::array;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Simple XOR Training (Graph API)");

    // 1. Data
    let inputs_data: Tensor = array![
        [0.0, 0.0],
        [0.0, 1.0],
        [1.0, 0.0],
        [1.0, 1.0]
    ].into_dyn().into();
    
    let targets_data: Tensor = array![
        [0.0],
        [1.0],
        [1.0],
        [0.0]
    ].into_dyn().into();

    // 2. Setup Graph
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    
    let input_node = graph.input(Tensor::new_zeros(&[4, 2]));
    
    let mut gb = GraphBuilder::new(&mut graph);
    
    // Hidden Layer: 2 -> 4
    let w1 = gb.param(Tensor::new_random(&[2, 4]));
    let b1 = gb.param(Tensor::new_zeros(&[1, 4]));
    let l1 = gb.linear(input_node, w1, b1);
    let r1 = gb.sigmoid(l1);
    
    // Output Layer: 4 -> 1
    let w2 = gb.param(Tensor::new_random(&[4, 1]));
    let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
    let l2 = gb.linear(r1, w2, b2);
    let output_node = gb.sigmoid(l2);

    let loss_fn = MSE;
    let learning_rate = 0.5;

    // 3. Training
    for epoch in 0..10001 {
        // Load data
        if let gran_prix::graph::Node::Input(ref mut t) = graph.nodes_mut()[input_node.0] {
             *t = inputs_data.clone();
        }

        // Forward
        let prediction = graph.execute(output_node)?;
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
    
    // 4. Test
    // Forward pass calls execute which returns the output tensor
    if let gran_prix::graph::Node::Input(ref mut t) = graph.nodes_mut()[input_node.0] {
             *t = inputs_data.clone();
    }
    let final_pred = graph.execute(output_node)?;
    println!("Final Predictions:\n{:?}", final_pred);

    Ok(())
}
