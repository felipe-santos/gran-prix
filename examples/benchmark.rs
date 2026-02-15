use gran_prix::backend::cpu::CPUBackend;
use gran_prix::backend::Backend;
use ndarray::Array2;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let backend = CPUBackend;
    
    // Large Matrix Multiplication (Professional Scale)
    let size = 1024;
    let a = Array2::<f32>::zeros((size, size));
    let b = Array2::<f32>::zeros((size, size));
    
    println!("Benchmarking MatMul ({}x{}) on CPU Backend...", size, size);
    
    let start = Instant::now();
    let _result = backend.matmul(&a, &b)?;
    let duration = start.elapsed();
    
    println!("Time taken: {:?}", duration);
    println!("GFLOPS: {:.2}", (2.0 * size as f64 * size as f64 * size as f64) / (duration.as_secs_f64() * 1e9));
    
    Ok(())
}
