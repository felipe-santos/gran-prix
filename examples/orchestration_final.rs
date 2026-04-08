use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::graph::verifier::Verifier;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::Tensor;

fn main() -> anyhow::Result<()> {
    println!("Gran-Prix: Graph Verification + Inference Demo");

    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    // 2-layer MLP: input → linear+relu → linear+sigmoid → output
    let x = gb.val(Tensor::from_shape_vec(&[1, 2], vec![1.0, 0.0])?);
    let w1 = gb.val(Tensor::from_shape_vec(&[2, 2], vec![0.5, 0.5, 0.5, 0.5])?);
    let b1 = gb.val(Tensor::from_shape_vec(&[1, 2], vec![0.0, 0.0])?);
    let h1 = gb.linear(x, w1, b1);
    let a1 = gb.relu(h1);

    let w2 = gb.val(Tensor::from_shape_vec(&[2, 2], vec![0.8, -0.2, 0.3, 0.7])?);
    let b2 = gb.val(Tensor::from_shape_vec(&[1, 2], vec![0.0, 0.0])?);
    let h2 = gb.linear(a1, w2, b2);
    let out = gb.sigmoid(h2);

    // Step 1: Static shape verification
    println!("--- Static Verification ---");
    let shapes = Verifier::verify(&graph)?;
    for (id, shape) in &shapes {
        println!("  Node {:?}: shape {:?}", id, shape);
    }

    // Step 2: Forward pass
    println!("\n--- Inference ---");
    let result = graph.execute(out)?;
    println!("Output: {:?}", result.as_slice()?);

    Ok(())
}
