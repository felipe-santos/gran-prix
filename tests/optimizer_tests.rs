use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::graph::optimizer::GraphOptimizer;
use gran_prix::backend::cpu::CPUBackend;
use ndarray::array;

#[test]
fn test_kernel_fusion_add_relu() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    let h1 = gb.val(array![[1.0, -1.0]]);
    let h2 = gb.val(array![[0.5, 0.5]]);
    let sum = gb.add(h1, h2);
    let out = gb.relu(sum);
    
    // Before optimization, last node is ReLU
    assert_eq!(graph.nodes().len(), 4);
    assert!(graph.nodes()[3].op().unwrap().name().contains("ReLU"));

    // Optimize
    GraphOptimizer::optimize(&mut graph);
    
    // After optimization:
    // 0: val, 1: val, 2: AddReLU, 3: NOP (ReLU replaced by AddReLU)
    // Actually the current optimizer implementation replaces node 3's OP and changes its inputs.
    assert!(graph.nodes()[3].op().unwrap().name().contains("Fused"));
    
    // Verify execution
    let res = graph.execute(out).unwrap();
    assert_eq!(res, array![[1.5, 0.0]]);
}
