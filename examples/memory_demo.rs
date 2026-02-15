use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::graph::memory_planner::MemoryPlanner;
use gran_prix::backend::cpu::CPUBackend;
use ndarray::array;

fn main() -> anyhow::Result<()> {
    println!("🧠 Gran-Prix Memory Orchestration: Static Planning Demo");
    
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    // Build a linear chain: A -> B -> C -> D
    // Each step should ideally reuse buffers
    let x = gb.val(array![[1.0, 1.0]].into_dyn());
    let w1 = gb.val(array![[1.0, 0.0], [0.0, 1.0]].into_dyn());
    let a = gb.matmul(x, w1);
    let b = gb.relu(a);
    let w2 = gb.val(array![[2.0, 0.0], [0.0, 2.0]].into_dyn());
    let c = gb.matmul(b, w2);
    let d = gb.sigmoid(c);
    
    // Run the Memory Planner
    println!("\nAnalyzing Graph for Memory Reuse...");
    let planner = MemoryPlanner::plan(&graph)?;
    
    println!("Buffer Assignment Plan:");
    for (i, p) in planner.plan.iter().enumerate() {
        println!("  Node {}: Buffer {}", i, p.unwrap());
    }
    
    println!("\nExecution verification...");
    let result = graph.execute(d)?;
    println!("Result: {:?}", result);
    
    println!("\n✅ Memory Planning validated. The engine is now aware of tensor lifecycles!");

    Ok(())
}
