use gran_prix::graph::Graph;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::{model, linear};
use ndarray::array;

fn main() -> anyhow::Result<()> {
    println!("✨ Gran-Prix Professional DX: Macro-based DSL");
    
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    
    // Using the macro for a cleaner look
    let target = model!(&mut graph, g => {
        let x = g.val(array![[1.0, 2.0]]);
        let w = g.param(array![[0.5, 0.1], [0.2, 0.4]]);
        let b = g.param(array![[0.1, 0.1]]);
        
        linear!(g, x, w, b) // Professional sugar
    });

    let result = graph.execute(target)?;
    println!("Execution Result: {:?}", result);
    
    println!("\n✅ Macro syntax validated. Clean, fast, and professional.");

    Ok(())
}
