use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use ndarray::array;

fn main() -> anyhow::Result<()> {
    println!("💾 Gran-Prix Professional Persistence: Graph Serialization");
    
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    // 1. Build a graph with inputs and params
    let x = gb.val(array![[1.0, 1.0]]);
    let w = gb.param(array![[0.5, 0.5], [0.5, 0.5]]);
    let out = gb.matmul(x, w);
    
    // 2. Serialize to JSON
    let json = serde_json::to_string_pretty(&graph)?;
    println!("Serialized Graph (Fragment):\n{}", &json[..200]);

    // 3. De-serialize into a new graph
    let mut new_graph: Graph = serde_json::from_str(&json)?;
    new_graph.set_backend(Box::new(CPUBackend)); // Re-attach backend
    
    // 4. Execute to verify state was preserved
    println!("\nExecuting Re-loaded Graph...");
    let result = new_graph.execute(out)?;
    println!("Result: {:?}", result);
    
    if result == array![[1.0, 1.0]] {
        println!("✅ SUCCESS: Graph was perfectly preserved through serialization.");
    } else {
        println!("❌ ERROR: Result mismatch after re-load.");
    }

    Ok(())
}
