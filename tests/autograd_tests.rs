use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use ndarray::array;

#[test]
fn test_autograd_simple_chain() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    // y = ReLU(x + w)
    let x = gb.val(array![[1.0, -2.0]].into_dyn());
    let w = gb.param(array![[0.5, 0.5]].into_dyn());
    let sum = gb.add(x, w);
    let out = gb.relu(sum);
    
    let result = graph.execute(out).unwrap();
    assert_eq!(result, array![[1.5, 0.0]].into_dyn());
    
    // Backward
    graph.backward(out, array![[1.0, 1.0]].into_dyn()).unwrap();
    
    // Grad wrt w: should be 1.0 for the first element, 0.0 for the second
    let grad_w = graph.get_gradient(w).unwrap();
    assert_eq!(*grad_w, array![[1.0, 0.0]].into_dyn());
}

#[test]
fn test_autograd_matmul() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    // y = x * w
    let x = gb.val(array![[1.0, 2.0]].into_dyn());
    let w = gb.param(array![[0.5, 0.1], [0.2, 0.4]].into_dyn());
    let out = gb.matmul(x, w);
    
    graph.execute(out).unwrap();
    graph.backward(out, array![[1.0, 1.0]].into_dyn()).unwrap();
    
    // Grad wrt w: x^T * grad_out
    // [[1], [2]] * [[1, 1]] = [[1, 1], [2, 2]]
    let grad_w = graph.get_gradient(w).unwrap();
    assert_eq!(*grad_w, array![[1.0, 1.0], [2.0, 2.0]].into_dyn());
}
