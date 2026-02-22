use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::loss::{Loss, BCEWithLogits};
use gran_prix::Tensor;

#[test]
fn test_multilayer_gradient_flow() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    // 2 inputs -> 8 hidden -> 4 hidden -> 1 output
    let x_data = Tensor::from(ndarray::ArrayD::from_elem(ndarray::IxDyn(&[1, 2]), 1.0));
    let x = gb.val(x_data);
    
    // Layer 1
    let w1 = gb.param(Tensor::from(ndarray::ArrayD::from_elem(ndarray::IxDyn(&[2, 8]), 0.1)));
    let b1 = gb.param(Tensor::from(ndarray::ArrayD::from_elem(ndarray::IxDyn(&[1, 8]), 0.0)));
    let l1 = gb.matmul(x, w1);
    let l1 = gb.add(l1, b1);
    let a1 = gb.tanh(l1);
    
    // Layer 2
    let w2 = gb.param(Tensor::from(ndarray::ArrayD::from_elem(ndarray::IxDyn(&[8, 4]), 0.1)));
    let b2 = gb.param(Tensor::from(ndarray::ArrayD::from_elem(ndarray::IxDyn(&[1, 4]), 0.0)));
    let l2 = gb.matmul(a1, w2);
    let l2 = gb.add(l2, b2);
    let a2 = gb.tanh(l2);
    
    // Layer 3 (Output)
    let w3 = gb.param(Tensor::from(ndarray::ArrayD::from_elem(ndarray::IxDyn(&[4, 1]), 0.1)));
    let b3 = gb.param(Tensor::from(ndarray::ArrayD::from_elem(ndarray::IxDyn(&[1, 1]), 0.0)));
    let l3 = gb.matmul(a2, w3);
    let out = gb.add(l3, b3);
    
    // Target
    let target = Tensor::from(ndarray::ArrayD::from_elem(ndarray::IxDyn(&[1, 1]), 1.0));
    
    // Forward
    let result = graph.execute(out).unwrap();
    println!("Forward result: {:?}", result);
    
    // Loss & Gradient
    let loss_fn = BCEWithLogits;
    let grad_out = loss_fn.gradient(&result, &target);
    println!("Loss gradient: {:?}", grad_out);
    
    // Backward
    graph.backward(out, grad_out).unwrap();
    
    // Check gradients
    let g_w3 = graph.get_gradient(w3).expect("W3 grad missing");
    let g_w2 = graph.get_gradient(w2).expect("W2 grad missing");
    let g_w1 = graph.get_gradient(w1).expect("W1 grad missing");
    
    let sum_abs_w3: f32 = g_w3.iter().map(|&x| x.abs()).sum();
    let sum_abs_w2: f32 = g_w2.iter().map(|&x| x.abs()).sum();
    let sum_abs_w1: f32 = g_w1.iter().map(|&x| x.abs()).sum();
    
    println!("Sum Abs W3: {}", sum_abs_w3);
    println!("Sum Abs W2: {}", sum_abs_w2);
    println!("Sum Abs W1: {}", sum_abs_w1);
    
    assert!(sum_abs_w3 > 0.0, "W3 gradient is zero");
    assert!(sum_abs_w2 > 0.0, "W2 gradient is zero");
    assert!(sum_abs_w1 > 0.0, "W1 gradient is zero");

    // --- VERIFY CONNECTIVITY ---
    println!("--- Verifying Connectivity ---");
    let val1 = graph.execute(out).unwrap().iter().next().cloned().unwrap();
    println!("Initial Output: {}", val1);

    // Mutate W1
    {
        if let Node::Param(ref mut t) = graph.nodes_mut()[w1.0] {
            t.as_cpu_mut().unwrap().map_inplace(|v| *v += 1.0);
        }
    }
    graph.sync_params().unwrap();

    let val2 = graph.execute(out).unwrap().iter().next().cloned().unwrap();
    println!("Mutated Output: {}", val2);

    assert_ne!(val1, val2, "Output did not change after mutating W1! Graph might be disconnected.");
    println!("Connectivity verified: Output changed from {} to {}", val1, val2);
}
