#[cfg(feature = "cuda")]
mod cuda_tests {
    use gran_prix::backend::cpu::CPUBackend;
    use gran_prix::backend::cuda::CUDABackend;
    use gran_prix::backend::Backend;
    use gran_prix::Tensor;
    use std::sync::Arc;

    #[test]
    fn test_cuda_cpu_parity() -> anyhow::Result<()> {
        let cuda_backend = match CUDABackend::new(0) {
            Ok(b) => Arc::new(b),
            Err(_) => {
                println!(
                    "Skipping CUDA parity test: No CUDA device found or initialization failed."
                );
                return Ok(());
            }
        };
        let cpu_backend = Arc::new(CPUBackend);

        let a = Tensor::from_shape_vec(&[2, 3], vec![1.0, -2.0, 3.0, 4.0, -5.0, 6.0])?;
        let b = Tensor::from_shape_vec(&[2, 3], vec![0.5, 2.0, -1.0, 3.0, 4.0, -2.0])?;
        let cuda_a = a.to_cuda(cuda_backend.device())?;
        let cuda_b = b.to_cuda(cuda_backend.device())?;

        assert_parity(
            &cpu_backend.add(&a, &b)?,
            &cuda_backend.add(&cuda_a, &cuda_b)?.to_host()?,
            "Add",
            1e-6,
        );
        assert_parity(
            &cpu_backend.mul(&a, &b)?,
            &cuda_backend.mul(&cuda_a, &cuda_b)?.to_host()?,
            "Mul",
            1e-6,
        );
        assert_parity(
            &cpu_backend.relu(&a)?,
            &cuda_backend.relu(&cuda_a)?.to_host()?,
            "ReLU",
            1e-6,
        );
        assert_parity(
            &cpu_backend.sigmoid(&a)?,
            &cuda_backend.sigmoid(&cuda_a)?.to_host()?,
            "Sigmoid",
            1e-6,
        );
        assert_parity(
            &cpu_backend.tanh(&a)?,
            &cuda_backend.tanh(&cuda_a)?.to_host()?,
            "Tanh",
            1e-6,
        );
        assert_parity(
            &cpu_backend.add_relu(&a, &b)?,
            &cuda_backend.add_relu(&cuda_a, &cuda_b)?.to_host()?,
            "AddReLU",
            1e-6,
        );

        let grad = Tensor::from_shape_vec(&[2, 3], vec![1.0, 0.5, -1.0, 2.0, -0.25, 0.75])?;
        let cuda_grad = grad.to_cuda(cuda_backend.device())?;
        assert_parity(
            &cpu_backend.relu_backward(&a, &grad)?,
            &cuda_backend.relu_backward(&cuda_a, &cuda_grad)?.to_host()?,
            "ReLU backward",
            1e-6,
        );

        let sigmoid_out = cpu_backend.sigmoid(&a)?;
        let cuda_sigmoid_out = sigmoid_out.to_cuda(cuda_backend.device())?;
        assert_parity(
            &cpu_backend.sigmoid_backward(&sigmoid_out, &grad)?,
            &cuda_backend
                .sigmoid_backward(&cuda_sigmoid_out, &cuda_grad)?
                .to_host()?,
            "Sigmoid backward",
            1e-6,
        );

        let tanh_out = cpu_backend.tanh(&a)?;
        let cuda_tanh_out = tanh_out.to_cuda(cuda_backend.device())?;
        assert_parity(
            &cpu_backend.tanh_backward(&tanh_out, &grad)?,
            &cuda_backend
                .tanh_backward(&cuda_tanh_out, &cuda_grad)?
                .to_host()?,
            "Tanh backward",
            1e-6,
        );

        let mut cpu_param = a.clone();
        let mut cuda_param = cuda_a.clone();
        cpu_backend.update_parameter(&mut cpu_param, &grad, 0.05)?;
        cuda_backend.update_parameter(&mut cuda_param, &cuda_grad, 0.05)?;
        assert_parity(&cpu_param, &cuda_param.to_host()?, "SGD update", 1e-6);

        let mm_a = Tensor::from_shape_vec(&[2, 3], vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0])?;
        let mm_b = Tensor::from_shape_vec(&[3, 2], vec![7.0, 8.0, 9.0, 10.0, 11.0, 12.0])?;
        assert_parity(
            &cpu_backend.matmul(&mm_a, &mm_b)?,
            &cuda_backend
                .matmul(
                    &mm_a.to_cuda(cuda_backend.device())?,
                    &mm_b.to_cuda(cuda_backend.device())?,
                )?
                .to_host()?,
            "MatMul",
            1e-5,
        );
        assert_parity(
            &cpu_backend.reduce_sum(&a, &[0], false)?,
            &cuda_backend.reduce_sum(&cuda_a, &[0], false)?.to_host()?,
            "ReduceSum axis 0",
            1e-6,
        );
        assert_parity(
            &cpu_backend.reduce_sum(&a, &[1], true)?,
            &cuda_backend.reduce_sum(&cuda_a, &[1], true)?.to_host()?,
            "ReduceSum axis 1 keep_dims",
            1e-6,
        );

        let t3 = Tensor::from_shape_vec(
            &[2, 2, 3],
            vec![
                1.0, 2.0, 3.0, 4.0, 5.0, 6.0, -1.0, -2.0, -3.0, 7.0, 8.0, 9.0,
            ],
        )?;
        let cuda_t3 = t3.to_cuda(cuda_backend.device())?;
        assert_parity(
            &cpu_backend.reduce_sum(&t3, &[0, 2], true)?,
            &cuda_backend
                .reduce_sum(&cuda_t3, &[0, 2], true)?
                .to_host()?,
            "ReduceSum axes 0,2 keep_dims",
            1e-6,
        );
        assert_parity(
            &cpu_backend.reduce_sum(&t3, &[0, 2], false)?,
            &cuda_backend
                .reduce_sum(&cuda_t3, &[0, 2], false)?
                .to_host()?,
            "ReduceSum axes 0,2",
            1e-6,
        );

        let n = 1;
        let ci = 1;
        let h = 4;
        let w = 4;
        let co = 1;
        let kh = 3;
        let kw = 3;

        // Build input data using the public Tensor API
        let mut input_vec = vec![0.0f32; n * ci * h * w];
        for ni in 0..n {
            for cii in 0..ci {
                for hi in 0..h {
                    for wi in 0..w {
                        let idx = ni * (ci * h * w) + cii * (h * w) + hi * w + wi;
                        input_vec[idx] = (ni + cii + hi + wi) as f32 * 0.1;
                    }
                }
            }
        }
        let input = Tensor::from_shape_vec(&[n, ci, h, w], input_vec).unwrap();

        let mut weight_vec = vec![0.0f32; co * ci * kh * kw];
        for coi in 0..co {
            for cii in 0..ci {
                for khi in 0..kh {
                    for kwi in 0..kw {
                        let idx = coi * (ci * kh * kw) + cii * (kh * kw) + khi * kw + kwi;
                        weight_vec[idx] = (coi + cii + khi + kwi) as f32 * 0.5;
                    }
                }
            }
        }
        let weight = Tensor::from_shape_vec(&[co, ci, kh, kw], weight_vec).unwrap();

        let stride = 1;
        let padding = 1;
        let pool_size = 2;

        let cpu_conv = cpu_backend.conv2d(&input, &weight, stride, padding)?;
        let cpu_relu = cpu_backend.relu(&cpu_conv)?;
        let cpu_pool = cpu_backend.max_pool2d(&cpu_relu, pool_size, pool_size)?;

        let cuda_input = input.to_cuda(cuda_backend.device())?;
        let cuda_weight = weight.to_cuda(cuda_backend.device())?;

        let cuda_conv = cuda_backend.conv2d(&cuda_input, &cuda_weight, stride, padding)?;
        let cuda_relu = cuda_backend.relu(&cuda_conv)?;
        let cuda_pool = cuda_backend.max_pool2d(&cuda_relu, pool_size, pool_size)?;

        let cuda_pool_host = cuda_pool.to_host()?;
        assert_parity(&cpu_pool, &cuda_pool_host, "Forward Pool Output", 1e-5);

        let grad_out = Tensor::new_ones(cpu_pool.shape());
        let cuda_grad_out = grad_out.to_cuda(cuda_backend.device())?;

        let cpu_grad_relu =
            cpu_backend.max_pool2d_backward(&cpu_relu, &grad_out, pool_size, pool_size)?;
        let cpu_grad_conv = cpu_backend.relu_backward(&cpu_conv, &cpu_grad_relu)?;
        let (cpu_grad_in, cpu_grad_w) =
            cpu_backend.conv2d_backward(&input, &weight, &cpu_grad_conv, stride, padding)?;

        let cuda_grad_relu =
            cuda_backend.max_pool2d_backward(&cuda_relu, &cuda_grad_out, pool_size, pool_size)?;
        let cuda_grad_conv = cuda_backend.relu_backward(&cuda_conv, &cuda_grad_relu)?;
        let (cuda_grad_in, cuda_grad_w) = cuda_backend.conv2d_backward(
            &cuda_input,
            &cuda_weight,
            &cuda_grad_conv,
            stride,
            padding,
        )?;

        assert_parity(&cpu_grad_in, &cuda_grad_in.to_host()?, "Grad Input", 1e-4);
        assert_parity(&cpu_grad_w, &cuda_grad_w.to_host()?, "Grad Weight", 1e-4);

        Ok(())
    }

    fn assert_parity(cpu: &Tensor, cuda: &Tensor, name: &str, tol: f32) {
        let cpu_slice = cpu.as_slice().unwrap();
        let cuda_slice = cuda.as_slice().unwrap();

        assert_eq!(cpu.shape(), cuda.shape(), "Shape mismatch for {}", name);

        let max_diff = cpu_slice
            .iter()
            .zip(cuda_slice.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);

        if max_diff > tol {
            panic!(
                "Parity check failed for {}: max diff is {}, tolerance is {}",
                name, max_diff, tol
            );
        }
        println!("Parity check passed for {}: max diff {}", name, max_diff);
    }
}
