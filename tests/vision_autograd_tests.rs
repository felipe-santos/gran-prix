use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::Tensor;
use ndarray::ArrayD;

#[test]
fn test_conv2d_autograd_complex() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    // [N=1, Ci=1, H=4, W=4]
    let input_data = ArrayD::from_shape_vec(vec![1, 1, 4, 4], vec![
        1.0, 2.0, 3.0, 4.0,
        5.0, 6.0, 7.0, 8.0,
        9.0, 10.0, 11.0, 12.0,
        13.0, 14.0, 15.0, 16.0
    ]).unwrap();
    
    // [Co=1, Ci=1, Kh=3, Kw=3]
    let weight_data = ArrayD::from_elem(vec![1, 1, 3, 3], 1.0);

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
    let grad_out = ArrayD::from_elem(vec![1, 1, 2, 2], 1.0);
    graph.backward(conv, grad_out.clone()).unwrap();

    let grad_input = graph.get_gradient(x).unwrap().clone();
    let grad_weight = graph.get_gradient(w).unwrap().clone();

    // Numerical Gradient Check
    let eps = 1e-4;
    
    // Check one weight grad
    let mut w_plus = weight_data.clone();
    w_plus[[0, 0, 1, 1]] += eps;
    let mut g_p = Graph::new(Box::new(CPUBackend));
    let mut gb_p = GraphBuilder::new(&mut g_p);
    let x_p = gb_p.val(input_data.clone());
    let w_p = gb_p.param(w_plus);
    let conv_p = gb_p.conv2d(x_p, w_p, stride, padding);
    let out_p = g_p.execute(conv_p).unwrap();
    let loss_p = out_p.iter().zip(grad_out.iter()).map(|(k, v)| *k * *v).sum::<f32>();

    let mut w_minus = weight_data.clone();
    w_minus[[0, 0, 1, 1]] -= eps;
    let mut g_m = Graph::new(Box::new(CPUBackend));
    let mut gb_m = GraphBuilder::new(&mut g_m);
    let x_m = gb_m.val(input_data.clone());
    let w_m = gb_m.param(w_minus);
    let conv_m = gb_m.conv2d(x_m, w_m, stride, padding);
    let out_m = g_m.execute(conv_m).unwrap();
    let loss_m = out_m.iter().zip(grad_out.iter()).map(|(k, v)| *k * *v).sum::<f32>();

    let numerical_grad_w = (loss_p - loss_m) / (2.0 * eps);
    let diff = (grad_weight[[0, 0, 1, 1]] - numerical_grad_w).abs();
    println!("Analytical W Grad: {}, Numerical: {}, Diff: {}", grad_weight[[0, 0, 1, 1]], numerical_grad_w, diff);
    assert!(diff < 5e-2);

    // Check one input grad
    let mut x_plus = input_data.clone();
    x_plus[[0, 0, 1, 1]] += eps;
    let mut g_px = Graph::new(Box::new(CPUBackend));
    let mut gb_px = GraphBuilder::new(&mut g_px);
    let x_px = gb_px.val(x_plus);
    let w_px = gb_px.param(weight_data.clone());
    let conv_px = gb_px.conv2d(x_px, w_px, stride, padding);
    let out_px = g_px.execute(conv_px).unwrap();
    let loss_px = out_px.iter().zip(grad_out.iter()).map(|(k, v)| *k * *v).sum::<f32>();

    let mut x_minus = input_data.clone();
    x_minus[[0, 0, 1, 1]] -= eps;
    let mut g_mx = Graph::new(Box::new(CPUBackend));
    let mut gb_mx = GraphBuilder::new(&mut g_mx);
    let x_mx = gb_mx.val(x_minus);
    let w_mx = gb_mx.param(weight_data.clone());
    let conv_mx = gb_mx.conv2d(x_mx, w_mx, stride, padding);
    let out_mx = g_mx.execute(conv_mx).unwrap();
    let loss_mx = out_mx.iter().zip(grad_out.iter()).map(|(k, v)| *k * *v).sum::<f32>();

    let numerical_grad_x = (loss_px - loss_mx) / (2.0 * eps);
    let diff_x = (grad_input[[0, 0, 1, 1]] - numerical_grad_x).abs();
    println!("Analytical X Grad: {}, Numerical: {}, Diff: {}", grad_input[[0, 0, 1, 1]], numerical_grad_x, diff_x);
    assert!(diff_x < 5e-2);
}

#[test]
fn test_max_pool2d_autograd_complex() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    // [N=1, Ci=1, H=4, W=4]
    let input_data = ArrayD::from_shape_vec(vec![1, 1, 4, 4], vec![
        1.0, 2.0, 3.0, 4.0,
        5.0, 6.0, 7.0, 8.0,
        9.0, 10.0, 11.0, 12.0,
        13.0, 14.0, 15.0, 16.0
    ]).unwrap();
    
    let x = gb.val(input_data.clone());
    // Stride 1, Kernel 2 -> Output 3x3
    let pool = gb.max_pool2d(x, 2, 1);

    // Forward
    let output = graph.execute(pool).unwrap();
    println!("Pool Output Shape: {:?}", output.shape());
    
    // Backward
    let grad_out = ArrayD::from_elem(vec![1, 1, 3, 3], 1.0);
    graph.backward(pool, grad_out.clone()).unwrap();

    let grad_input = graph.get_gradient(x).unwrap().clone();

    // Numerical Gradient Check
    let eps = 1e-4;
    let mut x_plus = input_data.clone();
    x_plus[[0, 0, 1, 1]] += eps;
    let mut g_p = Graph::new(Box::new(CPUBackend));
    let mut gb_p = GraphBuilder::new(&mut g_p);
    let x_p = gb_p.val(x_plus);
    let pool_p = gb_p.max_pool2d(x_p, 2, 1);
    let out_p = g_p.execute(pool_p).unwrap();
    let loss_p = out_p.iter().zip(grad_out.iter()).map(|(k, v)| *k * *v).sum::<f32>();

    let mut x_minus = input_data.clone();
    x_minus[[0, 0, 1, 1]] -= eps;
    let mut g_m = Graph::new(Box::new(CPUBackend));
    let mut gb_m = GraphBuilder::new(&mut g_m);
    let x_m = gb_m.val(x_minus);
    let pool_m = gb_m.max_pool2d(x_m, 2, 1);
    let out_m = g_m.execute(pool_m).unwrap();
    let loss_m = out_m.iter().zip(grad_out.iter()).map(|(k, v)| *k * *v).sum::<f32>();

    let numerical_grad_x = (loss_p - loss_m) / (2.0 * eps);
    let diff = (grad_input[[0, 0, 1, 1]] - numerical_grad_x).abs();
    println!("Analytical Pool X Grad: {}, Numerical: {}, Diff: {}", grad_input[[0, 0, 1, 1]], numerical_grad_x, diff);
    assert!(diff < 5e-2);
}
