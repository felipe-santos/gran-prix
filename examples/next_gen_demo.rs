use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::Tensor;

fn main() -> anyhow::Result<()> {
    println!("Gran-Prix Next-Gen Engine: DSL & Graph Demonstration");

    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);

    // Using the DSL (Fluent API)
    let mut gb = GraphBuilder::new(&mut graph);

    let x = gb.val(Tensor::from_shape_vec(&[1, 2], vec![1.0, 2.0])?);
    let w = gb.val(Tensor::from_shape_vec(&[2, 2], vec![0.5, 0.1, 0.2, 0.4])?);
    let b = gb.val(Tensor::from_shape_vec(&[1, 2], vec![0.1, 0.1])?);

    // High-level "Planta" construction
    let output_node = gb.linear(x, w, b);

    println!("Executing Professional DAG...");
    let result = graph.execute(output_node)?;

    println!("Input X: [1.0, 2.0]");
    println!("Weights W:\n[[0.5, 0.1],\n [0.2, 0.4]]");
    println!("Bias B: [0.1, 0.1]");
    println!("\nResult (XW + B): {:?}", result);

    Ok(())
}
