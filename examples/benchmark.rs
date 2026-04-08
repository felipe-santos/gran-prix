use gran_prix::graph::{Graph, dsl::GraphBuilder};
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::Tensor;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    println!("Gran-Prix Benchmark (Graph API)");

    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    let size = 500;

    // Create Inputs
    println!("Initializing tensors ({}x{})...", size, size);
    let a_data = Tensor::from_elem(&[size, size], 1.0);
    let b_data = Tensor::from_elem(&[size, size], 1.0);

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
