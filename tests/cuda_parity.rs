use gran_prix::Tensor;
#[cfg(feature = "cuda")]
use gran_prix::backend::cuda::CUDABackend;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::backend::Backend;
use ndarray::prelude::*;
use std::sync::Arc;

#[cfg(feature = "cuda")]
#[test]
fn test_cuda_cpu_parity() -> anyhow::Result<()> {
    // 1. Attempt to initialize CUDA. Skip test if no GPU found.
    let cuda_backend = match CUDABackend::new(0) {
        Ok(b) => Arc::new(b),
        Err(_) => {
            println!("Skipping CUDA parity test: No CUDA device found or initialization failed.");
            return Ok(());
        }
    };
    let cpu_backend = Arc::new(CPUBackend);

    // 2. Setup Data
    let n = 1;
    let ci = 1;
    let h = 4;
    let w = 4;
    let co = 1;
    let kh = 3;
    let kw = 3;
    
    let input_data = Array4::from_shape_fn((n, ci, h, w), |(ni, cii, hi, wi)| (ni + cii + hi + wi) as f32 * 0.1).into_dyn();
    let weight_data = Array4::from_shape_fn((co, ci, kh, kw), |(coi, cii, khi, kwi)| (coi + cii + khi + kwi) as f32 * 0.5).into_dyn();
    
    let input = Tensor::new_cpu(input_data);
    let weight = Tensor::new_cpu(weight_data);

    // 3. Build Graphs
    // Subgraph: Conv2D -> ReLU -> MaxPool2D
    let stride = 1;
    let padding = 1;
    let pool_size = 2;

    // We'll run the operations manually on backends to avoid DSL ambiguity in parity test
    
    // FORWARD
    let cpu_conv = cpu_backend.conv2d(&input, &weight, stride, padding)?;
    let cpu_relu = cpu_backend.relu(&cpu_conv)?;
    let cpu_pool = cpu_backend.max_pool2d(&cpu_relu, pool_size, pool_size)?;

    let cuda_input = input.to_cuda(cuda_backend.device())?;
    let cuda_weight = weight.to_cuda(cuda_backend.device())?;

    let cuda_conv = cuda_backend.conv2d(&cuda_input, &cuda_weight, stride, padding)?;
    let cuda_relu = cuda_backend.relu(&cuda_conv)?;
    let cuda_pool = cuda_backend.max_pool2d(&cuda_relu, pool_size, pool_size)?;

    // Compare Forward
    let cuda_pool_host = cuda_pool.to_host()?;
    assert_parity(&cpu_pool, &cuda_pool_host, "Forward Pool Output", 1e-5);

    // BACKWARD
    let grad_out_data = ArrayD::ones(cpu_pool.shape());
    let grad_out = Tensor::new_cpu(grad_out_data);
    let cuda_grad_out = grad_out.to_cuda(cuda_backend.device())?;

    // CPU Backward
    let cpu_grad_relu = cpu_backend.max_pool2d_backward(&cpu_relu, &grad_out, pool_size, pool_size)?;
    let cpu_grad_conv = cpu_backend.relu_backward(&cpu_conv, &cpu_grad_relu)?;
    let (cpu_grad_in, cpu_grad_w) = cpu_backend.conv2d_backward(&input, &weight, &cpu_grad_conv, stride, padding)?;

    // CUDA Backward
    let cuda_grad_relu = cuda_backend.max_pool2d_backward(&cuda_relu, &cuda_grad_out, pool_size, pool_size)?;
    let cuda_grad_conv = cuda_backend.relu_backward(&cuda_conv, &cuda_grad_relu)?;
    let (cuda_grad_in, cuda_grad_w) = cuda_backend.conv2d_backward(&cuda_input, &cuda_weight, &cuda_grad_conv, stride, padding)?;

    // Compare Backward Results
    assert_parity(&cpu_grad_in, &cuda_grad_in.to_host()?, "Grad Input", 1e-4);
    assert_parity(&cpu_grad_w, &cuda_grad_w.to_host()?, "Grad Weight", 1e-4);

    Ok(())
}

fn assert_parity(cpu: &Tensor, cuda: &Tensor, name: &str, tol: f32) {
    let cpu_view = cpu.view();
    let cuda_view = cuda.view();
    
    assert_eq!(cpu_view.shape(), cuda_view.shape(), "Shape mismatch for {}", name);
    
    let diff = (&cpu_view - &cuda_view).mapv(|v| v.abs());
    let max_diff = diff.fold(0.0f32, |m, &d| if d > m { d } else { m });
    
    if max_diff > tol {
        panic!("Parity check failed for {}: max diff is {}, tolerance is {}", name, max_diff, tol);
    }
    println!("✅ Parity check passed for {}: max diff {}", name, max_diff);
}
