use gran_prix::backend::cpu::CPUBackend;
use gran_prix::backend::Backend;
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
