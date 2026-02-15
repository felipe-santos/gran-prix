use gran_prix::graph::{Graph, dsl::GraphBuilder};
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::loss::{Loss, MSE};
use gran_prix::Tensor;
use gran_prix::tensor::TensorOps;
use ndarray::array;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🎮 Gran-Prix Game AI Demo: Learning to Avoid Obstacles (Graph API)");
    

    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    
    let input_node = graph.input(Tensor::new_zeros(&[4, 2]));
    
    let mut gb = GraphBuilder::new(&mut graph);
    
    // Layer 1
    let w1 = gb.param(Tensor::new_random(&[2, 8]));
    let b1 = gb.param(Tensor::new_zeros(&[1, 8]));
    let l1 = gb.linear(input_node, w1, b1);
    let r1 = gb.relu(l1);
    
    // Layer 2
    let w2 = gb.param(Tensor::new_random(&[8, 1]));
    let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
    let l2 = gb.linear(r1, w2, b2);
    let output_node = gb.sigmoid(l2);
    
    
    // 3. Data
    // Scenario: Obstacle is always on the right if distance is small.
    // [Distance, Velocity] -> [Turn Speed]
    let inputs_data: Tensor = array![
        [1.0, 1.0], // Safe -> Straight (0.5)
        [0.2, 0.8], // Danger -> Left (0.0)
        [0.9, 0.2], // Safe -> Straight (0.5)
        [0.1, 1.0]  // Danger -> Left (0.0)
    ].into_dyn().into();
    
    let targets_data: Tensor = array![
        [0.5],
        [0.0],
        [0.5],
        [0.0]
    ].into_dyn().into();

    let loss_fn = MSE;
    let learning_rate = 0.2;

    // 4. Training Loop
    println!("Training...");
    for frame in 0..200 {
        // Load data into input node (hack for now: we just mutate the input tensor or create a new graph? 
        // actually Graph::execute takes NodeId. 
        // But the input node holds a Tensor. We need to update that Tensor.
        // Graph API currently stores Input Tensors in the Node enum.
        // We can access graph.nodes_mut() to update the input tensor.
        // Or we can use a feed_dict style?
        // For now, let's update the node content.
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
        
        // Clear for next iteration
        graph.clear_values();
        graph.clear_gradients();
        
        if frame % 20 == 0 {
            println!("Frame {}: Learning Error = {:.6}", frame, loss);
        }
    }
    
    // 5. Test
    println!("\nTesting...");
    let new_danger: Tensor = array![[0.15, 0.9], [0.15, 0.9], [0.15, 0.9], [0.15, 0.9]].into_dyn().into(); // Batch of 4 for shape match
    // Note: Our graph has hardcoded batch size of 4 implicitly if inputs are 4?
    // Actually, operations usually handle batch size dynamically if shapes match.
    // But our input node was initialized with specific tensor.
    // If we update input node with new tensor of different batch size, it should work 
    // IF the operations support it (MatMul does).
    
    if let gran_prix::graph::Node::Input(ref mut t) = graph.nodes_mut()[input_node.0] {
         *t = new_danger.clone();
    }
    graph.clear_values();
    let action = graph.execute(output_node)?;
    
    println!("NPC Decision for [Distance: 0.15, Velocity: 0.9]: {:.4}", action.view()[[0, 0]]);
    if action.view()[[0, 0]] < 0.2 {
        println!("Result: 🏃 Safe! NPC successfully learned to swerve left.");
    } else {
        println!("Result: 💥 Crash! NPC needs more training.");
    }
    
    Ok(())
}
