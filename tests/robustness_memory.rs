use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::graph::memory_planner::MemoryPlanner;
use gran_prix::graph::verifier::Verifier;
use gran_prix::backend::cpu::CPUBackend;
use ndarray::array;

#[test]
fn test_memory_collision_safety() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    // Very dense graph with shared inputs
    let x = gb.val(array![[1.0, 1.0]]);
    let a = gb.relu(x);
    let b = gb.sigmoid(x);
    let c = gb.add(a, b);
    let _d = gb.relu(c);
    
    // Verify that the memory planner handles concurrent lifespans correctly
    let plan = MemoryPlanner::plan(&graph).unwrap();
    
    // 'a' and 'b' are used together in 'c'. They MUST have different buffer indices.
    let node_a_id = 1; // Assuming sequential IDs
    let node_b_id = 2;
    
    let buffer_a = plan.plan[node_a_id].unwrap();
    let buffer_b = plan.plan[node_b_id].unwrap();
    
    assert_ne!(buffer_a, buffer_b, "Simultaneous buffers must be distinct");
}

#[test]
fn test_verifier_large_dimension_safety() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    // MatMul with dimension mismatch at scale
    let x = gb.val(ndarray::Array2::zeros((100, 50)));
    let w = gb.val(ndarray::Array2::zeros((40, 100))); // Incorrect 40 instead of 50
    let _out = gb.matmul(x, w);
    
    let res = Verifier::verify(&graph);
    assert!(res.is_err());
    println!("Verifier successfully blocked mismatched large matmul.");
}
