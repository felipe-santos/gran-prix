use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::Tensor;

#[test]
fn test_conv2d_autograd_complex() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    // [N=1, Ci=1, H=4, W=4]
    let input_data_vec = vec![
        1.0, 2.0, 3.0, 4.0,
        5.0, 6.0, 7.0, 8.0,
        9.0, 10.0, 11.0, 12.0,
        13.0, 14.0, 15.0, 16.0
    ];
    let input_data = Tensor::from_shape_vec(&[1, 1, 4, 4], input_data_vec.clone()).unwrap();

    // [Co=1, Ci=1, Kh=3, Kw=3]
    let weight_data = Tensor::from_elem(&[1, 1, 3, 3], 1.0);

    let x = gb.val(input_data.clone());
    let w = gb.param(weight_data.clone());

    // Stride 2, Padding 1 -> Output 2x2
    let stride = 2;
    let padding = 1;
    let conv = gb.conv2d(x, w, stride, padding);

    // Forward
    let output = graph.execute(conv).unwrap();
    println!("Output Shape: {:?}", output.shape());

    // Backward
    let grad_out = Tensor::from_elem(&[1, 1, 2, 2], 1.0);
    graph.backward(conv, grad_out.clone()).unwrap();

    let grad_input = graph.get_gradient(x).unwrap().clone();
    let grad_weight = graph.get_gradient(w).unwrap().clone();

    // Numerical Gradient Check
    let eps = 1e-4;
    let grad_out_slice = grad_out.as_slice().unwrap();

    // Check one weight grad
    let mut w_plus_vec = weight_data.to_vec().unwrap();
    // Index [0,0,1,1] in shape [1,1,3,3] -> flat index = 0*9 + 0*9 + 1*3 + 1 = 4
    w_plus_vec[4] += eps;
    let w_plus = Tensor::from_shape_vec(&[1, 1, 3, 3], w_plus_vec).unwrap();
    let mut g_p = Graph::new(Box::new(CPUBackend));
    let mut gb_p = GraphBuilder::new(&mut g_p);
    let x_p = gb_p.val(Tensor::from_shape_vec(&[1, 1, 4, 4], input_data_vec.clone()).unwrap());
    let w_p = gb_p.param(w_plus);
    let conv_p = gb_p.conv2d(x_p, w_p, stride, padding);
    let out_p = g_p.execute(conv_p).unwrap();
    let out_p_slice = out_p.as_slice().unwrap();
    let loss_p: f32 = out_p_slice.iter().zip(grad_out_slice.iter()).map(|(k, v)| *k * *v).sum();

    let mut w_minus_vec = weight_data.to_vec().unwrap();
    w_minus_vec[4] -= eps;
    let w_minus = Tensor::from_shape_vec(&[1, 1, 3, 3], w_minus_vec).unwrap();
    let mut g_m = Graph::new(Box::new(CPUBackend));
    let mut gb_m = GraphBuilder::new(&mut g_m);
    let x_m = gb_m.val(Tensor::from_shape_vec(&[1, 1, 4, 4], input_data_vec.clone()).unwrap());
    let w_m = gb_m.param(w_minus);
    let conv_m = gb_m.conv2d(x_m, w_m, stride, padding);
    let out_m = g_m.execute(conv_m).unwrap();
    let out_m_slice = out_m.as_slice().unwrap();
    let loss_m: f32 = out_m_slice.iter().zip(grad_out_slice.iter()).map(|(k, v)| *k * *v).sum();

    let numerical_grad_w = (loss_p - loss_m) / (2.0 * eps);
    let analytical_grad_w = grad_weight.get_2d(0, 4).unwrap_or_else(|_| {
        // Flat index 4 corresponds to [0,0,1,1] in a [1,1,3,3] tensor
        grad_weight.get_flat(4).unwrap()
    });
    let diff = (analytical_grad_w - numerical_grad_w).abs();
    println!("Analytical W Grad: {}, Numerical: {}, Diff: {}", analytical_grad_w, numerical_grad_w, diff);
    assert!(diff < 5e-2);

    // Check one input grad
    let mut x_plus_vec = input_data_vec.clone();
    // Index [0,0,1,1] in shape [1,1,4,4] -> flat index = 0*16 + 0*16 + 1*4 + 1 = 5
    x_plus_vec[5] += eps;
    let x_plus = Tensor::from_shape_vec(&[1, 1, 4, 4], x_plus_vec).unwrap();
    let mut g_px = Graph::new(Box::new(CPUBackend));
    let mut gb_px = GraphBuilder::new(&mut g_px);
    let x_px = gb_px.val(x_plus);
    let w_px = gb_px.param(weight_data.clone());
    let conv_px = gb_px.conv2d(x_px, w_px, stride, padding);
    let out_px = g_px.execute(conv_px).unwrap();
    let out_px_slice = out_px.as_slice().unwrap();
    let loss_px: f32 = out_px_slice.iter().zip(grad_out_slice.iter()).map(|(k, v)| *k * *v).sum();

    let mut x_minus_vec = input_data_vec.clone();
    x_minus_vec[5] -= eps;
    let x_minus = Tensor::from_shape_vec(&[1, 1, 4, 4], x_minus_vec).unwrap();
    let mut g_mx = Graph::new(Box::new(CPUBackend));
    let mut gb_mx = GraphBuilder::new(&mut g_mx);
    let x_mx = gb_mx.val(x_minus);
    let w_mx = gb_mx.param(weight_data.clone());
    let conv_mx = gb_mx.conv2d(x_mx, w_mx, stride, padding);
    let out_mx = g_mx.execute(conv_mx).unwrap();
    let out_mx_slice = out_mx.as_slice().unwrap();
    let loss_mx: f32 = out_mx_slice.iter().zip(grad_out_slice.iter()).map(|(k, v)| *k * *v).sum();

    let numerical_grad_x = (loss_px - loss_mx) / (2.0 * eps);
    let analytical_grad_x = grad_input.get_flat(5).unwrap();
    let diff_x = (analytical_grad_x - numerical_grad_x).abs();
    println!("Analytical X Grad: {}, Numerical: {}, Diff: {}", analytical_grad_x, numerical_grad_x, diff_x);
    assert!(diff_x < 5e-2);
}

#[test]
fn test_max_pool2d_autograd_complex() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    // [N=1, Ci=1, H=4, W=4]
    let input_data_vec = vec![
        1.0, 2.0, 3.0, 4.0,
        5.0, 6.0, 7.0, 8.0,
        9.0, 10.0, 11.0, 12.0,
        13.0, 14.0, 15.0, 16.0
    ];
    let input_data = Tensor::from_shape_vec(&[1, 1, 4, 4], input_data_vec.clone()).unwrap();

    let x = gb.val(input_data.clone());
    // Stride 1, Kernel 2 -> Output 3x3
    let pool = gb.max_pool2d(x, 2, 1);

    // Forward
    let output = graph.execute(pool).unwrap();
    println!("Pool Output Shape: {:?}", output.shape());

    // Backward
    let grad_out = Tensor::from_elem(&[1, 1, 3, 3], 1.0);
    graph.backward(pool, grad_out.clone()).unwrap();

    let grad_input = graph.get_gradient(x).unwrap().clone();
    let grad_out_slice = grad_out.as_slice().unwrap();

    // Numerical Gradient Check
    let eps = 1e-4;
    let mut x_plus_vec = input_data_vec.clone();
    // Index [0,0,1,1] -> flat index 5
    x_plus_vec[5] += eps;
    let x_plus = Tensor::from_shape_vec(&[1, 1, 4, 4], x_plus_vec).unwrap();
    let mut g_p = Graph::new(Box::new(CPUBackend));
    let mut gb_p = GraphBuilder::new(&mut g_p);
    let x_p = gb_p.val(x_plus);
    let pool_p = gb_p.max_pool2d(x_p, 2, 1);
    let out_p = g_p.execute(pool_p).unwrap();
    let out_p_slice = out_p.as_slice().unwrap();
    let loss_p: f32 = out_p_slice.iter().zip(grad_out_slice.iter()).map(|(k, v)| *k * *v).sum();

    let mut x_minus_vec = input_data_vec.clone();
    x_minus_vec[5] -= eps;
    let x_minus = Tensor::from_shape_vec(&[1, 1, 4, 4], x_minus_vec).unwrap();
    let mut g_m = Graph::new(Box::new(CPUBackend));
    let mut gb_m = GraphBuilder::new(&mut g_m);
    let x_m = gb_m.val(x_minus);
    let pool_m = gb_m.max_pool2d(x_m, 2, 1);
    let out_m = g_m.execute(pool_m).unwrap();
    let out_m_slice = out_m.as_slice().unwrap();
    let loss_m: f32 = out_m_slice.iter().zip(grad_out_slice.iter()).map(|(k, v)| *k * *v).sum();

    let numerical_grad_x = (loss_p - loss_m) / (2.0 * eps);
    let analytical_grad_x = grad_input.get_flat(5).unwrap();
    let diff = (analytical_grad_x - numerical_grad_x).abs();
    println!("Analytical Pool X Grad: {}, Numerical: {}, Diff: {}", analytical_grad_x, numerical_grad_x, diff);
    assert!(diff < 5e-2);
}
