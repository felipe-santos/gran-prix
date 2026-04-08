use gran_prix::Tensor;
use gran_prix::graph::{Graph, dsl::GraphBuilder};
use gran_prix::backend::cpu::CPUBackend;

#[test]
fn test_activation_relu() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    let input = Tensor::from_shape_vec(&[1, 4], vec![-1.0, 0.0, 0.5, 2.0]).unwrap();
    let input_id = gb.val(input);
    let relu_id = gb.relu(input_id);

    let result = graph.execute(relu_id).expect("ReLU execution failed");
    let data = result.as_slice().expect("Failed to get CPU slice");

    assert_eq!(data[0], 0.0, "ReLU(-1.0) should be 0.0");
    assert_eq!(data[1], 0.0, "ReLU(0.0) should be 0.0");
    assert_eq!(data[2], 0.5, "ReLU(0.5) should be 0.5");
    assert_eq!(data[3], 2.0, "ReLU(2.0) should be 2.0");
}

#[test]
fn test_activation_sigmoid() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    let input = Tensor::from_shape_vec(&[1, 3], vec![-100.0, 0.0, 100.0]).unwrap();
    let input_id = gb.val(input);
    let sig_id = gb.sigmoid(input_id);

    let result = graph.execute(sig_id).expect("Sigmoid execution failed");
    let data = result.as_slice().expect("Failed to get CPU slice");

    // Sigmoid(-100) -> 0, Sigmoid(0) -> 0.5, Sigmoid(100) -> 1
    assert!(data[0] < 0.0001, "Sigmoid(-100) should be near 0");
    assert!((data[1] - 0.5).abs() < 0.0001, "Sigmoid(0) should be 0.5");
    assert!(data[2] > 0.9999, "Sigmoid(100) should be near 1");
}

#[test]
fn test_matmul_verification() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    // 2x3 Matrix
    let a = Tensor::from_shape_vec(&[2, 3], vec![
        1.0, 2.0, 3.0,
        4.0, 5.0, 6.0
    ]).unwrap();

    // 3x2 Matrix
    let b = Tensor::from_shape_vec(&[3, 2], vec![
        7.0, 8.0,
        9.0, 10.0,
        11.0, 12.0
    ]).unwrap();

    let a_id = gb.val(a);
    let b_id = gb.val(b);
    let res_id = gb.matmul(a_id, b_id);

    let result = graph.execute(res_id).expect("MatMul execution failed");
    let data = result.as_slice().expect("Failed to get CPU slice");

    // [1*7 + 2*9 + 3*11, 1*8 + 2*10 + 3*12] -> [7+18+33, 8+20+36] -> [58, 64]
    // [4*7 + 5*9 + 6*11, 4*8 + 5*10 + 6*12] -> [28+45+66, 32+50+72] -> [139, 154]
    // Shape is [2, 2], row-major: [58, 64, 139, 154]
    assert_eq!(data[0], 58.0);
    assert_eq!(data[1], 64.0);
    assert_eq!(data[2], 139.0);
    assert_eq!(data[3], 154.0);
}

#[test]
fn test_numerical_stability_nan() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    // Test if we can handle NaN without crashing the engine (even if result is NaN)
    let input = Tensor::from_shape_vec(&[1, 1], vec![f32::NAN]).unwrap();
    let input_id = gb.val(input);
    let relu_id = gb.relu(input_id);

    let result = graph.execute(relu_id).expect("Should not crash on NaN");
    let data = result.as_slice().expect("Failed to get CPU slice");
    assert!(data[0].is_nan());
}
