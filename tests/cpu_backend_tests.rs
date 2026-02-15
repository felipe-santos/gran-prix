use gran_prix::backend::cpu::CPUBackend;
use gran_prix::backend::Backend;
use ndarray::array;

#[test]
fn test_cpu_matmul() {
    let backend = CPUBackend;
    let a = array![[1.0, 2.0], [3.0, 4.0]].into_dyn();
    let b = array![[5.0, 6.0], [7.0, 8.0]].into_dyn();
    
    let res = backend.matmul_t(&a, &b, false, false).unwrap();
    let expected = array![[19.0, 22.0], [43.0, 50.0]].into_dyn();
    assert_eq!(res, expected);
}

#[test]
fn test_cpu_sigmoid() {
    let backend = CPUBackend;
    let x = array![[0.0, 1.0]].into_dyn();
    let res = backend.sigmoid(&x).unwrap();
    
    // For ArrayD, we access using IxDyn or a slice
    assert!((res[[0, 0]] - 0.5).abs() < 1e-6);
    assert!((res[[0, 1]] - 0.7310586).abs() < 1e-6);
}

#[test]
fn test_cpu_relu() {
    let backend = CPUBackend;
    let x = array![[-1.0, 2.0, 0.0]].into_dyn();
    let res = backend.relu(&x).unwrap();
    let expected = array![[0.0, 2.0, 0.0]].into_dyn();
    assert_eq!(res, expected);
}

#[test]
fn test_cpu_add_relu_fused() {
    let backend = CPUBackend;
    let a = array![[-1.0, 1.0]].into_dyn();
    let b = array![[-1.0, 1.0]].into_dyn();
    let res = backend.add_relu(&a, &b).unwrap();
    let expected = array![[0.0, 2.0]].into_dyn();
    assert_eq!(res, expected);
}
