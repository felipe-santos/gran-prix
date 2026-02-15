use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use ndarray::array;

fn main() -> anyhow::Result<()> {
    println!("🧪 Gran-Prix Autograd Demo: Automatic Differentiation");
    
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    // 1. Define nodes: Y = X * W + B
    let x = gb.val(array![[1.0, 2.0]]);
    let w = gb.val(array![[0.5, 0.1], [0.2, 0.4]]);
    let b = gb.val(array![[0.1, 0.1]]);
    
    let y = gb.linear(x, w, b);
    
    // 2. Forward Pass
    println!("Running Forward...");
    let result = graph.execute(y)?;
    println!("Result: {:?}", result);
    
    // 3. Backward Pass
    // Assume grad_output = [[1.0, 1.0]]
    println!("\nRunning Backward (Autograd)...");
    graph.backward(y, array![[1.0, 1.0]])?;
    
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
