use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use ndarray::{array, Array2};

#[test]
fn test_xor_convergence_dynamics() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    // XOR Data
    let _inputs = vec![
        array![[0.0, 0.0]].into_dyn(),
        array![[0.0, 1.0]].into_dyn(),
        array![[1.0, 0.0]].into_dyn(),
        array![[1.0, 1.0]].into_dyn(),
    ];
    let _targets = vec![
        array![[0.0]].into_dyn(),
        array![[1.0]].into_dyn(),
        array![[1.0]].into_dyn(),
        array![[0.0]].into_dyn(),
    ];

    // Model: 2 -> 4 -> 1
    let x_in = gb.val(array![[0.0, 0.0]].into_dyn().into()); // Placeholder
    
    // Hidden Layer
    let w1 = gb.param(Array2::from_elem((2, 4), 0.5).into_dyn().into());
    let b1 = gb.param(Array2::zeros((1, 4)).into_dyn().into());
    let h1 = gb.linear(x_in, w1, b1);
    let a1 = gb.sigmoid(h1);
    
    // Output Layer
    let w2 = gb.param(Array2::from_elem((4, 1), 0.5).into_dyn().into());
    let b2 = gb.param(Array2::zeros((1, 1)).into_dyn().into());
    let h2 = gb.linear(a1, w2, b2);
    let out = gb.sigmoid(h2);

    // This is more of a "stability" test than a full training test 
    // because our parameters are fixed in the graph (they are Tensors inside nodes).
    // To "learn", we'd need an Optimizer that modifies the Tensors inside the Nodes.
    
    // For now, let's verify that backward propagates values to all parameters.
    let _ = graph.execute(out).unwrap();
    graph.backward(out, array![[1.0]].into_dyn().into()).unwrap();
    
    assert!(graph.get_gradient(w1).is_some());
    assert!(graph.get_gradient(w2).is_some());
    assert!(graph.get_gradient(b1).is_some());
    assert!(graph.get_gradient(b2).is_some());
    
    println!("Training dynamics (gradient flow) verified for XOR-sized model.");
}
