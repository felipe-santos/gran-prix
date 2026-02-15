use gran_prix::backend::cpu::CPUBackend;
use gran_prix::backend::Backend;
use ndarray::Array2;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let backend = CPUBackend;
    
    // Large Matrix Multiplication (Professional Scale)
    let size = 500; // Defined size for GFLOPS calculation
    let a = Array2::from_elem((size, size), 1.0).into_dyn();
    let b = Array2::from_elem((size, size), 1.0).into_dyn();
    
    println!("Benchmarking MatMul ({}x{}) x 50 iterations...", size, size);
    let start = Instant::now();
    for _ in 0..50 {
        let _result = backend.matmul_t(&a, &b, false, false)?;
    }
    let duration = start.elapsed();
    
    println!("Time taken: {:?}", duration);
    // GFLOPS calculation adjusted for 50 iterations
    println!("GFLOPS: {:.2}", (2.0 * size as f64 * size as f64 * size as f64 * 50.0) / (duration.as_secs_f64() * 1e9));
    
    Ok(())
}
