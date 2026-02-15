use gran_prix::graph::{Graph, dsl::GraphBuilder};
use gran_prix::backend::cpu::CPUBackend;
use ndarray::Array2;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    println!("🚀 Gran-Prix Benchmark (Graph API)");
    
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    let size = 500;
    
    // Create Inputs
    println!("Initializing tensors ({}x{})...", size, size);
    let a_data = Array2::from_elem((size, size), 1.0f32).into_dyn().into();
    let b_data = Array2::from_elem((size, size), 1.0f32).into_dyn().into();
    
    let a = gb.val(a_data);
    let b = gb.val(b_data);
    
    // Operation
    let c = gb.matmul(a, b);
    
    // Warmup
    println!("Warmup...");
    graph.execute(c)?;
    
    println!("Benchmarking MatMul ({}x{}) x 50 iterations...", size, size);
    let start = Instant::now();
    for _ in 0..50 {
        graph.execute(c)?;
        // Ideally we should clear values if we were changing inputs, 
        // but for pure execute benchmarking on static graph, it recomputes.
        // Actually Graph::execute computes if values are missing.
        // So we need to clear 'c' value or all values to force recompute.
        graph.clear_values(); 
    }
    let duration = start.elapsed();
    
    println!("Time taken: {:?}", duration);
    // GFLOPS calculation adjusted for 50 iterations
    // 2 * N^3 operations per matmul
    let ops = 2.0 * (size as f64).powi(3) * 50.0;
    let seconds = duration.as_secs_f64();
    let gflops = ops / (seconds * 1e9);
    
    println!("GFLOPS: {:.2}", gflops);
    
    Ok(())
}
