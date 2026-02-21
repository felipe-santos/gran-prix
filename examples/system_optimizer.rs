use gran_prix::graph::{Graph, dsl::GraphBuilder};
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::loss::{Loss, MSE};
use gran_prix::Tensor;
use ndarray::array;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("System Optimizer Demo (Graph API)");
    
    // 1. Data (Mock system metrics)
    // [CPU%, RAM%] -> [Scaling Factor]
    let inputs_data: Tensor = array![
        [0.1, 0.2], // Low load
        [0.8, 0.9], // High load
        [0.4, 0.4]  // Med load
    ].into_dyn().into();
    
    // Target scaling factors
    let targets_data: Tensor = array![
        [1.0], // Min replicas
        [10.0], // Max replicas
        [3.0]  // Mid replicas
    ].into_dyn().into();

    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    
    let input_node = graph.input(Tensor::new_zeros(&[3, 2]));
    
    let mut gb = GraphBuilder::new(&mut graph);
    
    // Model architecture
    // 2 -> 6 -> 1
    let w1 = gb.param(Tensor::new_random(&[2, 6]));
    let b1 = gb.param(Tensor::new_zeros(&[1, 6]));
    let l1 = gb.linear(input_node, w1, b1);
    let r1 = gb.relu(l1);
    
    let w2 = gb.param(Tensor::new_random(&[6, 1]));
    let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
    let output_node = gb.linear(r1, w2, b2); // Linear output for regression

    let loss_fn = MSE;
    let learning_rate = 0.01;

    // Training loop
    for i in 0..1000 {
        if let gran_prix::graph::Node::Input(ref mut t) = graph.nodes_mut()[input_node.0] {
             *t = inputs_data.clone();
        }

        let pred = graph.execute(output_node)?;
        let loss = loss_fn.calculate(&pred, &targets_data);
        
        let grad = loss_fn.gradient(&pred, &targets_data);
        graph.backward(output_node, grad)?;
        graph.update_parameters(learning_rate)?;
        
        graph.clear_values();
        graph.clear_gradients();
        
        if i % 100 == 0 {
            println!("Step {}: Loss = {:.4}", i, loss);
        }
    }
    
    Ok(())
}
