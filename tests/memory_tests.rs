use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::graph::memory_planner::MemoryPlanner;
use gran_prix::graph::verifier::Verifier;
use gran_prix::backend::cpu::CPUBackend;
use ndarray::array;

#[test]
fn test_memory_planning_reuse() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    let x = gb.val(array![[1.0, 1.0]]);
    let a = gb.relu(x);
    let b = gb.sigmoid(a);
    let _c = gb.relu(b);
    
    let planner = MemoryPlanner::plan(&graph).unwrap();
    // Chain of 4 nodes, should reuse buffers
    assert!(planner.buffer_count < 4);
}

#[test]
fn test_verifier_shape_capture() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    let x = gb.val(array![[1.0, 2.0, 3.0]]); // [1, 3]
    let w = gb.val(array![[0.1, 0.1], [0.1, 0.1]]); // [2, 2]
    let _out = gb.matmul(x, w); // SHAPE MISMATCH
    
    let res = Verifier::verify(&graph);
    assert!(res.is_err());
    assert!(res.unwrap_err().to_string().contains("Shape mismatch"));
}
