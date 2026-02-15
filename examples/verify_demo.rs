use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::graph::verifier::Verifier;
use gran_prix::backend::cpu::CPUBackend;
use ndarray::array;

fn main() -> anyhow::Result<()> {
    println!("🛡️ Gran-Prix Static Safety Demo: Shape Validation");
    
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    // 1. Build a VALID graph
    println!("Case 1: Validating a correct graph...");
    let x = gb.val(array![[1.0, 2.0]]); // [1, 2]
    let w = gb.val(array![[0.5, 0.1], [0.2, 0.4]]); // [2, 2]
    let _ = gb.matmul(x, w); // Should be [1, 2]
    
    Verifier::verify(&graph)?;
    println!("✅ Valid graph passed.");

    // 2. Build an INVALID graph (Shape Mismatch)
    println!("\nCase 2: Validating an incorrect graph (Shape Mismatch)...");
    let mut bad_graph = Graph::new(Box::new(CPUBackend));
    let mut bgb = GraphBuilder::new(&mut bad_graph);
    
    let x2 = bgb.val(array![[1.0, 2.0, 3.0]]); // [1, 3]
    let w2 = bgb.val(array![[0.5, 0.1], [0.2, 0.4]]); // [2, 2]
    let _ = bgb.matmul(x2, w2); // Mismatch! 3 != 2
    
    match Verifier::verify(&bad_graph) {
        Ok(_) => println!("❌ ERROR: Verifier failed to catch shape mismatch!"),
        Err(e) => println!("✅ SUCCESS: Verifier caught error: {}", e),
    }

    Ok(())
}
