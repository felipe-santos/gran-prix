use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::graph::memory_planner::MemoryPlanner;
use gran_prix::graph::buffer_pool::BufferPool;
use gran_prix::graph::verifier::Verifier;
use gran_prix::backend::cpu::CPUBackend;
use ndarray::array;

#[test]
fn test_buffer_recycling() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    // Sequential Ops that could reuse buffers
    let x = gb.val(array![[1.0, 1.0]].into_dyn().into());
    let a = gb.relu(x);
    let b = gb.relu(a);
    let c = gb.relu(b);
    
    let _res = graph.execute(c).unwrap();
    
    // Verify that the memory planner exists and has a plan
    let planner = MemoryPlanner::plan(&graph).unwrap();
    assert!(planner.buffer_count > 0);
}

#[test]
fn test_memory_pool_allocation() {
    let mut pool = BufferPool::new(1);
    let shape = vec![2, 2];
    
    let b1 = pool.get_buffer(0, gran_prix::Shape::from(shape.clone()));
    assert_eq!(b1.shape(), &[2, 2]);
    
    // Test verifier with different shapes
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    let x = gb.val(array![[1.0, 2.0, 3.0]].into_dyn().into()); // [1, 3]
    let w = gb.val(array![[0.1, 0.1], [0.1, 0.1]].into_dyn().into()); // [2, 2]
    let _out = gb.matmul(x, w); // Should fail verification
    
    let res = Verifier::verify(&graph);
    assert!(res.is_err());
    assert!(res.unwrap_err().to_string().contains("Shape mismatch"));
}
