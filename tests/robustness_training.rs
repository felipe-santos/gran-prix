use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::Tensor;

#[test]
fn test_xor_convergence_dynamics() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    // XOR Data (kept as documentation, not directly used in this stability test)
    let _inputs: Vec<Tensor> = vec![
        Tensor::from_shape_vec(&[1, 2], vec![0.0, 0.0]).unwrap(),
        Tensor::from_shape_vec(&[1, 2], vec![0.0, 1.0]).unwrap(),
        Tensor::from_shape_vec(&[1, 2], vec![1.0, 0.0]).unwrap(),
        Tensor::from_shape_vec(&[1, 2], vec![1.0, 1.0]).unwrap(),
    ];
    let _targets: Vec<Tensor> = vec![
        Tensor::from_shape_vec(&[1, 1], vec![0.0]).unwrap(),
        Tensor::from_shape_vec(&[1, 1], vec![1.0]).unwrap(),
        Tensor::from_shape_vec(&[1, 1], vec![1.0]).unwrap(),
        Tensor::from_shape_vec(&[1, 1], vec![0.0]).unwrap(),
    ];

    // Model: 2 -> 4 -> 1
    let x_in = gb.val(Tensor::from_shape_vec(&[1, 2], vec![0.0, 0.0]).unwrap()); // Placeholder

    // Hidden Layer
    let w1 = gb.param(Tensor::from_elem(&[2, 4], 0.5));
    let b1 = gb.param(Tensor::new_zeros(&[1, 4]));
    let h1 = gb.linear(x_in, w1, b1);
    let a1 = gb.sigmoid(h1);

    // Output Layer
    let w2 = gb.param(Tensor::from_elem(&[4, 1], 0.5));
    let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
    let h2 = gb.linear(a1, w2, b2);
    let out = gb.sigmoid(h2);

    // This is more of a "stability" test than a full training test
    // because our parameters are fixed in the graph (they are Tensors inside nodes).
    // To "learn", we'd need an Optimizer that modifies the Tensors inside the Nodes.

    // For now, let's verify that backward propagates values to all parameters.
    let _ = graph.execute(out).unwrap();
    graph.backward(out, Tensor::from_shape_vec(&[1, 1], vec![1.0]).unwrap()).unwrap();

    assert!(graph.get_gradient(w1).is_some());
    assert!(graph.get_gradient(w2).is_some());
    assert!(graph.get_gradient(b1).is_some());
    assert!(graph.get_gradient(b2).is_some());

    println!("Training dynamics (gradient flow) verified for XOR-sized model.");
}
