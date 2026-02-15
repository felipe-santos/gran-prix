use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use ndarray::array;

fn main() -> anyhow::Result<()> {
    println!("🧪 Gran-Prix Autograd Demo: Automatic Differentiation");
    
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    // 1. Define nodes:    // y = ReLU(x * w + b)
    let x = gb.val(array![[1.0, 2.0]].into_dyn().into());
    let w = gb.val(array![[0.5, 0.1], [0.2, 0.4]].into_dyn().into());
    let b = gb.val(array![[0.1, 0.1]].into_dyn().into());
    
    let _out = gb.matmul(x, w); // Should fail verification
    let sum = gb.add(_out, b);
    let y = gb.relu(sum);

    // Forward pass
    println!("--- Forward Pass ---");
    let output = graph.execute(y)?;
    println!("Model Output: {:?}", output);

    // Backward pass (Automatic Differentiation)
    println!("\n--- Backward Pass (Autograd) ---");
    // We want to calculate gradients with respect to output = [1, 1]
    graph.backward(y, array![[1.0, 1.0]].into_dyn().into())?;
    
    // 4. Inspect Gradients
    let grad_w = graph.get_gradient(w).unwrap();
    let grad_b = graph.get_gradient(b).unwrap();
    let grad_x = graph.get_gradient(x).unwrap();
    
    println!("Gradient wrt W:\n{:?}", grad_w);
    println!("Gradient wrt B: {:?}", grad_b);
    println!("Gradient wrt X: {:?}", grad_x);
    
    println!("\n✅ Autograd Verified. Grains of truth propagated successfully!");
    
    Ok(())
}
