use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::graph::optimizer::GraphOptimizer;
use gran_prix::backend::cpu::CPUBackend;
use ndarray::array;

fn main() -> anyhow::Result<()> {
    println!("🚀 Gran-Prix Optimization Demo: Kernel Fusion (Add + ReLU)");
    
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    // 1. Construct a sub-optimal graph: (A + B) -> ReLU
    let a = gb.val(array![[1.0, -2.0]].into_dyn().into());
    let b = gb.val(array![[0.5, 0.5]].into_dyn().into());
    let sum = gb.add(a, b);
    let output = gb.relu(sum);
    
    println!("Graph constructed (Node {} is ReLU pointing to Node {} Add)", output.0, sum.0);

    // 2. Run the Optimizer
    let _ = GraphOptimizer::optimize(&mut graph);

    // 3. Execution
    println!("\nExecuting Optimized Graph...");
    let result = graph.execute(output)?;
    
    println!("Final Result: {:?}", result);
    println!("(Expected: ReLU([1.5, -1.5]) = [1.5, 0.0])");

    Ok(())
}
