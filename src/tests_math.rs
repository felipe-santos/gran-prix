use crate::Tensor;
use crate::graph::{Graph, dsl::GraphBuilder};
use crate::backend::cpu::CPUBackend;
use crate::loss::{Loss, BCEWithLogits};

#[test]
fn test_multilayer_backprop_flow() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    let input_val = Tensor::from_shape_vec(&[1, 2], vec![1.0, -1.0]).unwrap();
    let input_id = gb.val(input_val);

    // Layer 1: 2 → 4
    let w1 = gb.param(Tensor::new_random(&[2, 4]));
    let b1 = gb.param(Tensor::new_zeros(&[1, 4]));
    let l1_mm = gb.matmul(input_id, w1);
    let l1_add = gb.add(l1_mm, b1);
    let l1 = gb.tanh(l1_add);

    // Layer 2: 4 → 1
    let w2 = gb.param(Tensor::new_random(&[4, 1]));
    let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
    let l2_mm = gb.matmul(l1, w2);
    let output = gb.add(l2_mm, b2);

    // Forward
    let pred = graph.execute(output).unwrap();

    // Backward
    let target = Tensor::from_elem(&[1, 1], 1.0);
    let grad_output = BCEWithLogits.gradient(&pred, &target).unwrap();
    graph.backward(output, grad_output).unwrap();

    // Verify gradients reach both layers
    let mut w1_idx = None;
    let mut w2_idx = None;
    for (i, node) in graph.nodes().iter().enumerate() {
        if let crate::graph::Node::Param(_) = node {
            if w1_idx.is_none() { w1_idx = Some(i); }
            else if w2_idx.is_none() { w2_idx = Some(i); }
        }
    }

    let w2_grad = graph.get_gradient(crate::NodeId(w2_idx.unwrap()))
        .expect("W2 should have gradient");
    let w2_sum: f32 = w2_grad.as_slice().unwrap().iter().map(|x| x.abs()).sum();
    assert!(w2_sum > 0.0, "W2 gradient is zero");

    let w1_grad = graph.get_gradient(crate::NodeId(w1_idx.unwrap()))
        .expect("W1 should have gradient");
    let w1_sum: f32 = w1_grad.as_slice().unwrap().iter().map(|x| x.abs()).sum();
    assert!(w1_sum > 0.0, "W1 gradient is zero — signal lost at layer 2");
}
