use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::Tensor;
use ndarray::array;

fn main() -> anyhow::Result<()> {
    println!("💾 Graph Persistence Demo");

    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    let x = gb.val(array![[1.0, 2.0]].into_dyn().into());
    let w = gb.param(Tensor::new_random(&[2, 2]));
    let y = gb.matmul(x, w);

    // Execute once
    let _ = graph.execute(y)?;
    println!("Graph executed.");

    // Serialize
    let json = serde_json::to_string_pretty(&graph)?;
    println!("Serialized Graph JSON:\n{}", json);

    // Deserialize
    let mut loaded_graph: Graph = serde_json::from_str(&json)?;
    loaded_graph.set_backend(Box::new(CPUBackend));
    println!("Graph loaded successfully.");
    
    // Re-execute
    // Note: NodeIds are indices, so 'y' (index 2) is still valid if graph structure is same.
    let res = loaded_graph.execute(y)?;
    println!("Re-execution Result: {:?}", res);

    Ok(())
}
