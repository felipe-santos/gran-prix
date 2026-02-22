use crate::Tensor;
use crate::graph::{Graph, dsl::GraphBuilder};
use crate::backend::cpu::CPUBackend;
use crate::loss::{Loss, BCEWithLogits};

#[test]
fn test_multilayer_backprop_flow() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    // 2 inputs, 1 hidden (4 neurons), 1 output
    let input_val = Tensor::new_cpu(ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 2]), vec![1.0, -1.0]).unwrap());
    let input_id = gb.val(input_val);
    
    // Layer 1
    let w1 = gb.param(Tensor::new_random(&[2, 4]));
    let b1 = gb.param(Tensor::new_zeros(&[1, 4]));
    let l1_matmul = gb.matmul(input_id, w1);
    let l1_add = gb.add(l1_matmul, b1);
    let l1_out = gb.tanh(l1_add);
    
    // Layer 2 (Output)
    let w2 = gb.param(Tensor::new_random(&[4, 1]));
    let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
    let l2_matmul = gb.matmul(l1_out, w2);
    let output_node = gb.add(l2_matmul, b2);

    // Forward Pass
    let pred = graph.execute(output_node).unwrap();
    println!("Prediction: {:?}", pred.as_cpu().unwrap());
    
    // Backward Pass
    let target = Tensor::new_cpu(ndarray::ArrayD::from_elem(ndarray::IxDyn(&[1, 1]), 1.0));
    let loss_fn = BCEWithLogits;
    let grad_output = loss_fn.gradient(&pred, &target);
    println!("Initial Gradient (Loss -> Output): {:?}", grad_output.as_cpu().unwrap());
    
    graph.backward(output_node, grad_output).unwrap();
    
    // Check Gradients for ALL nodes
    println!("--- Node Gradients ---");
    let mut w1_idx = None;
    let mut w2_idx = None;
    for i in 0..graph.nodes().len() {
        let grad_opt = graph.get_gradient(crate::NodeId(i));
        let name = match &graph.nodes()[i] {
            crate::graph::Node::Input(_) => "Input",
            crate::graph::Node::Param(_) => {
                if w1_idx.is_none() { w1_idx = Some(i); }
                else if w2_idx.is_none() { w2_idx = Some(i); }
                "Param"
            },
            crate::graph::Node::Op { op, .. } => op.name(),
        };
        
        if let Some(grad) = grad_opt {
            let sum_abs: f32 = grad.as_cpu().unwrap().iter().map(|x| x.abs()).sum();
            println!("Node {} ({}): Abs-Sum Grad = {}", i, name, sum_abs);
        } else {
            println!("Node {} ({}): NO GRADIENT", i, name);
        }
    }
    
    // Check if w1 and w2 have gradients
    let w2_grad = graph.get_gradient(crate::NodeId(w2_idx.unwrap())).expect("W2 should have gradient");
    let w2_sum: f32 = w2_grad.as_cpu().unwrap().iter().map(|x| x.abs()).sum();
    println!("Final Check W2 (Output Layer): {}", w2_sum);
    assert!(w2_sum > 0.0, "W2 (Output Layer) gradient is zero!");

    let w1_grad = graph.get_gradient(crate::NodeId(w1_idx.unwrap())).expect("W1 should have gradient");
    let w1_sum: f32 = w1_grad.as_cpu().unwrap().iter().map(|x| x.abs()).sum();
    println!("Final Check W1 (Hidden Layer): {}", w1_sum);
    assert!(w1_sum > 0.0, "W1 (Hidden Layer) gradient is zero! Signal lost at layer 2.");
}
