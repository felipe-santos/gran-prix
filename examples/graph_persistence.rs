use gran_prix::graph::Graph;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::{model, linear};
use ndarray::array;

fn main() -> anyhow::Result<()> {
    println!("💾 Gran-Prix Professional Persistence: Graph Serialization");
    
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    
    let out_node = model!(&mut graph, g => {
        let x = g.val(array![[1.0, 2.0]].into_dyn().into());
        let w = g.param(array![[0.5, 0.1], [0.2, 0.4]].into_dyn().into());
        let b = g.param(array![[0.1, 0.1]].into_dyn().into());
        linear!(g, x, w, b)
    });

    let result = graph.execute(out_node)?;
    if result.view() == array![[1.0, 1.0]].into_dyn().view() {
        println!("✅ Original graph execution successful!");
    }
    
    // 2. Serialize to JSON
    let json = serde_json::to_string_pretty(&graph)?;
    println!("Serialized Graph (Fragment):\n{}", &json[..200]);

    // 3. De-serialize into a new graph
    let mut new_graph: Graph = serde_json::from_str(&json)?;
    new_graph.set_backend(Box::new(CPUBackend)); // Re-attach backend
    
    // 4. Execute to verify state was preserved
    println!("\nExecuting Re-loaded Graph...");
    let result = new_graph.execute(out_node)?;
    println!("Result: {:?}", result);
    
    if result.view() == array![[1.0, 1.0]].into_dyn().view() {
        println!("✅ SUCCESS: Graph was perfectly preserved through serialization.");
    } else {
        println!("❌ ERROR: Result mismatch after re-load.");
    }
 bitumen

    Ok(())
}
