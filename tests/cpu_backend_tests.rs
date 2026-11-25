use gran_prix::backend::cpu::CPUBackend;
use gran_prix::backend::Backend;
use gran_prix::graph::{Graph, OpType};
use gran_prix::Tensor;

#[test]
fn test_cpu_matmul() {
    let backend = CPUBackend;
    let a = Tensor::from_shape_vec(&[2, 2], vec![1.0, 2.0, 3.0, 4.0]).unwrap();
    let b = Tensor::from_shape_vec(&[2, 2], vec![5.0, 6.0, 7.0, 8.0]).unwrap();

    let res = backend.matmul_t(&a, &b, false, false).unwrap();
    let expected = Tensor::from_shape_vec(&[2, 2], vec![19.0, 22.0, 43.0, 50.0]).unwrap();
    assert_eq!(res, expected);
}

#[test]
fn test_cpu_backend_rejects_invalid_spatial_shapes() {
    let backend = CPUBackend;
    let input = Tensor::from_shape_vec(&[1, 1, 2, 2], vec![1.0; 4]).unwrap();
    let large_weight = Tensor::from_shape_vec(&[1, 1, 3, 3], vec![1.0; 9]).unwrap();
    let grad_out = Tensor::from_shape_vec(&[1, 1, 1, 1], vec![1.0]).unwrap();

    assert!(backend.conv2d(&input, &large_weight, 1, 0).is_err());
    assert!(backend.conv2d(&input, &large_weight, 0, 1).is_err());
    assert!(backend
        .conv2d(&input, &large_weight, 1, usize::MAX)
        .is_err());
    assert!(backend
        .conv2d_backward(&input, &large_weight, &grad_out, 1, 0)
        .is_err());

    assert!(backend.max_pool2d(&input, 3, 1).is_err());
    assert!(backend.max_pool2d(&input, 2, 0).is_err());
    assert!(backend
        .max_pool2d_backward(&input, &grad_out, 3, 1)
        .is_err());

    assert!(OpType::Conv2D {
        stride: 1,
        padding: usize::MAX
    }
    .output_shape(&[vec![1, 1, 2, 2], vec![1, 1, 3, 3]])
    .is_err());
    assert!(OpType::MaxPool2D {
        kernel_size: 3,
        stride: 1
    }
    .output_shape(&[vec![1, 1, 2, 2]])
    .is_err());
}

#[test]
fn test_cpu_matmul_rejects_invalid_rank_without_panicking() {
    let backend = CPUBackend;
    let vector = Tensor::from_shape_vec(&[3], vec![1.0, 2.0, 3.0]).unwrap();
    let matrix = Tensor::from_shape_vec(&[3, 1], vec![1.0, 2.0, 3.0]).unwrap();

    assert!(backend.matmul_t(&vector, &matrix, false, false).is_err());
}

#[test]
fn test_cpu_sigmoid() {
    let backend = CPUBackend;
    let x = Tensor::from_shape_vec(&[1, 2], vec![0.0, 1.0]).unwrap();
    let res = backend.sigmoid(&x).unwrap();

    let slice = res.as_slice().unwrap();
    assert!((slice[0] - 0.5).abs() < 1e-6);
    assert!((slice[1] - 0.7310586).abs() < 1e-6);
}

#[test]
fn test_cpu_relu() {
    let backend = CPUBackend;
    let x = Tensor::from_shape_vec(&[1, 3], vec![-1.0, 2.0, 0.0]).unwrap();
    let res = backend.relu(&x).unwrap();
    let expected = Tensor::from_shape_vec(&[1, 3], vec![0.0, 2.0, 0.0]).unwrap();
    assert_eq!(res, expected);
}

#[test]
fn test_cpu_add_relu_fused() {
    let backend = CPUBackend;
    let a = Tensor::from_shape_vec(&[1, 2], vec![-1.0, 1.0]).unwrap();
    let b = Tensor::from_shape_vec(&[1, 2], vec![-1.0, 1.0]).unwrap();
    let res = backend.add_relu(&a, &b).unwrap();
    let expected = Tensor::from_shape_vec(&[1, 2], vec![0.0, 2.0]).unwrap();
    assert_eq!(res, expected);
}

#[test]
fn test_add_relu_inplace_recomputes_from_inputs() {
    let mut graph = Graph::new(Box::new(CPUBackend));
    let a = graph.input(Tensor::from_shape_vec(&[1, 2], vec![-2.0, 1.0]).unwrap());
    let b = graph.input(Tensor::from_shape_vec(&[1, 2], vec![1.0, 2.0]).unwrap());
    let out = graph.op(OpType::AddReLU, vec![a, b]);

    let first = graph.execute(out).unwrap();
    assert_eq!(first.as_slice().unwrap(), &[0.0, 3.0]);

    if let gran_prix::graph::Node::Input(t) = &mut graph.nodes_mut()[a.0] {
        *t = Tensor::from_shape_vec(&[1, 2], vec![3.0, -5.0]).unwrap();
    }
    if let gran_prix::graph::Node::Input(t) = &mut graph.nodes_mut()[b.0] {
        *t = Tensor::from_shape_vec(&[1, 2], vec![4.0, 1.0]).unwrap();
    }

    let second = graph.execute(out).unwrap();
    assert_eq!(second.as_slice().unwrap(), &[7.0, 0.0]);
}
