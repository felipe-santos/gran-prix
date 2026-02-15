use gran_prix::layers::linear::Linear;
use gran_prix::Layer;
use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::tensor::{Tensor, TensorOps};
use ndarray::array;

#[test]
fn test_linear_layer_robustness() {
    // Setup Graph
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    // 1. Create Layer
    let mut layer = Linear::new(3, 2);
    
    // 2. Forward pass precision
    let input_tensor = Tensor::from(array![[1.0, 2.0, 3.0]].into_dyn());
    let input_id = gb.val(input_tensor);
    
    let output_id = layer.forward(input_id, &mut gb);
    
    // Verify Graph Structure for Output Shape (Static Analysis)
    // Note: Graph doesn't store shapes directly on nodes yet without running verifier.
    // We strictly test execution here.
    
    // Execute
    let out = graph.execute(output_id).expect("Execution failed");
    assert_eq!(out.shape(), &[1, 2]);
}

#[test]
fn test_sequential_stacking() {
    // This tests if our Layer trait allows composition
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    let mut l1 = Linear::new(10, 5);
    let mut l2 = Linear::new(5, 1);
    
    let x = gb.val(Tensor::new_zeros(&[1, 10]));
    
    let h = l1.forward(x, &mut gb);
    let out = l2.forward(h, &mut gb);
    
    let res = graph.execute(out).expect("Execution failed");
    assert_eq!(res.shape(), &[1, 1]);
}
