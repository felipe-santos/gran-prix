//! Tests for Dropout and BatchNorm correctness.

use gran_prix::graph::{Graph, dsl::GraphBuilder, OpType};
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::loss::{Loss, MSE};
use gran_prix::Tensor;

// ────────────────────────────────────────────────────────────────────────────
// DROPOUT TESTS
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_dropout_inference_is_identity() {
    let mut graph = Graph::new(Box::new(CPUBackend));
    let input = graph.input(Tensor::from_shape_vec(&[1, 4], vec![1.0, 2.0, 3.0, 4.0]).unwrap());
    let mut gb = GraphBuilder::new(&mut graph);
    let output = gb.dropout(input, 0.5);

    // Default is inference mode → identity
    let result = graph.execute(output).unwrap();
    assert_eq!(result.as_slice().unwrap(), &[1.0, 2.0, 3.0, 4.0]);
}

#[test]
fn test_dropout_training_zeroes_some_elements() {
    let mut graph = Graph::new(Box::new(CPUBackend));
    let input = graph.input(Tensor::from_shape_vec(
        &[1, 100],
        vec![1.0; 100],
    ).unwrap());
    let mut gb = GraphBuilder::new(&mut graph);
    let output = gb.dropout(input, 0.5);

    graph.set_training(true);
    let result = graph.execute(output).unwrap();
    let slice = result.as_slice().unwrap();

    // With 50% dropout, some should be 0 and others non-zero (scaled by 1/(1-rate))
    let zeros = slice.iter().filter(|&&x| x == 0.0).count();
    let nonzeros = slice.iter().filter(|&&x| x != 0.0).count();

    assert!(zeros > 10, "Should have some zeroed elements, got {}", zeros);
    assert!(nonzeros > 10, "Should have some non-zero elements, got {}", nonzeros);
    assert_eq!(zeros + nonzeros, 100);

    // Non-zero values should be scaled by 1/(1-0.5) = 2.0
    for &v in slice.iter().filter(|&&x| x != 0.0) {
        assert!((v - 2.0).abs() < 1e-4, "Non-zero should be ~2.0, got {}", v);
    }
}

#[test]
fn test_dropout_rate_zero_is_identity() {
    let mut graph = Graph::new(Box::new(CPUBackend));
    let input = graph.input(Tensor::from_shape_vec(&[1, 4], vec![1.0, 2.0, 3.0, 4.0]).unwrap());
    let mut gb = GraphBuilder::new(&mut graph);
    let output = gb.dropout(input, 0.0);

    graph.set_training(true); // Even in training, rate=0 → identity
    let result = graph.execute(output).unwrap();
    assert_eq!(result.as_slice().unwrap(), &[1.0, 2.0, 3.0, 4.0]);
}

#[test]
fn test_dropout_preserves_shape() {
    let mut graph = Graph::new(Box::new(CPUBackend));
    let input = graph.input(Tensor::new_zeros(&[4, 8]));
    let mut gb = GraphBuilder::new(&mut graph);
    let output = gb.dropout(input, 0.3);

    graph.set_training(true);
    let result = graph.execute(output).unwrap();
    assert_eq!(result.shape(), &[4, 8]);
}

// ────────────────────────────────────────────────────────────────────────────
// BATCHNORM TESTS
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_batchnorm_normalizes_to_zero_mean() {
    // Input: 4 samples, 2 features. Feature 0 has values [2,4,6,8] → mean=5
    let mut graph = Graph::new(Box::new(CPUBackend));
    let input = graph.input(Tensor::from_shape_vec(&[4, 2], vec![
        2.0, 10.0,
        4.0, 20.0,
        6.0, 30.0,
        8.0, 40.0,
    ]).unwrap());

    let mut gb = GraphBuilder::new(&mut graph);
    // gamma=1, beta=0 → output should be normalized (mean≈0, var≈1)
    let gamma = gb.param(Tensor::new_ones(&[1, 2]));
    let beta = gb.param(Tensor::new_zeros(&[1, 2]));
    let output = gb.node(OpType::BatchNorm { epsilon: 1e-5 }, vec![input, gamma, beta]);

    let result = graph.execute(output).unwrap();
    let s = result.as_slice().unwrap();

    // Check mean of each feature is approximately 0
    let mean_f0 = (s[0] + s[2] + s[4] + s[6]) / 4.0;
    let mean_f1 = (s[1] + s[3] + s[5] + s[7]) / 4.0;
    assert!(mean_f0.abs() < 1e-5, "Feature 0 mean should be ~0, got {}", mean_f0);
    assert!(mean_f1.abs() < 1e-5, "Feature 1 mean should be ~0, got {}", mean_f1);

    // Check variance of each feature is approximately 1
    let var_f0 = (s[0]*s[0] + s[2]*s[2] + s[4]*s[4] + s[6]*s[6]) / 4.0;
    let var_f1 = (s[1]*s[1] + s[3]*s[3] + s[5]*s[5] + s[7]*s[7]) / 4.0;
    assert!((var_f0 - 1.0).abs() < 0.01, "Feature 0 var should be ~1, got {}", var_f0);
    assert!((var_f1 - 1.0).abs() < 0.01, "Feature 1 var should be ~1, got {}", var_f1);
}

#[test]
fn test_batchnorm_gamma_beta_learnable() {
    // gamma=2, beta=3 → output = 2 * normalized + 3
    let mut graph = Graph::new(Box::new(CPUBackend));
    let input = graph.input(Tensor::from_shape_vec(&[4, 1], vec![
        1.0, 3.0, 5.0, 7.0,
    ]).unwrap());

    let mut gb = GraphBuilder::new(&mut graph);
    let gamma = gb.param(Tensor::from_shape_vec(&[1, 1], vec![2.0]).unwrap());
    let beta = gb.param(Tensor::from_shape_vec(&[1, 1], vec![3.0]).unwrap());
    let output = gb.node(OpType::BatchNorm { epsilon: 1e-5 }, vec![input, gamma, beta]);

    let result = graph.execute(output).unwrap();
    let s = result.as_slice().unwrap();

    // Normalized [1,3,5,7]: mean=4, std≈2.236 → [-1.342, -0.447, 0.447, 1.342]
    // After gamma*x+beta: [-2.683+3, -0.894+3, 0.894+3, 2.683+3] = [0.317, 2.106, 3.894, 5.683]
    let mean_out = (s[0] + s[1] + s[2] + s[3]) / 4.0;
    assert!((mean_out - 3.0).abs() < 0.01, "Mean of output should be ~3 (beta), got {}", mean_out);
}

#[test]
fn test_batchnorm_backward_produces_gradients() {
    let mut graph = Graph::new(Box::new(CPUBackend));
    let input = graph.input(Tensor::from_shape_vec(&[4, 2], vec![
        1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0,
    ]).unwrap());

    let mut gb = GraphBuilder::new(&mut graph);
    let gamma = gb.param(Tensor::new_ones(&[1, 2]));
    let beta = gb.param(Tensor::new_zeros(&[1, 2]));
    let bn = gb.node(OpType::BatchNorm { epsilon: 1e-5 }, vec![input, gamma, beta]);

    // Forward pass
    let pred = graph.execute(bn).unwrap();

    // Use a non-zero target so gradient is non-zero
    let target = Tensor::from_shape_vec(&[4, 2], vec![
        1.0, -1.0, 0.5, -0.5, 0.0, 0.0, -1.0, 1.0,
    ]).unwrap();
    let grad = MSE.gradient(&pred, &target).unwrap();

    graph.backward(bn, grad).unwrap();

    // gamma and beta should have gradients
    let gamma_grad = graph.params().gradient(gran_prix::ParamId(0));
    let beta_grad = graph.params().gradient(gran_prix::ParamId(1));
    assert!(gamma_grad.is_some(), "Gamma should have gradient");
    assert!(beta_grad.is_some(), "Beta should have gradient");

    let g_sum: f32 = gamma_grad.unwrap().as_slice().unwrap().iter().map(|x| x.abs()).sum();
    let b_sum: f32 = beta_grad.unwrap().as_slice().unwrap().iter().map(|x| x.abs()).sum();
    assert!(g_sum > 0.0, "Gamma gradient should be non-zero");
    assert!(b_sum > 0.0, "Beta gradient should be non-zero");
}

#[test]
fn test_batchnorm_preserves_shape() {
    let mut graph = Graph::new(Box::new(CPUBackend));
    let input = graph.input(Tensor::new_zeros(&[8, 4]));
    let mut gb = GraphBuilder::new(&mut graph);
    let gamma = gb.param(Tensor::new_ones(&[1, 4]));
    let beta = gb.param(Tensor::new_zeros(&[1, 4]));
    let output = gb.node(OpType::BatchNorm { epsilon: 1e-5 }, vec![input, gamma, beta]);

    let result = graph.execute(output).unwrap();
    assert_eq!(result.shape(), &[8, 4]);
}

// ────────────────────────────────────────────────────────────────────────────
// TRAINING MODE INTEGRATION
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_training_mode_toggle() {
    let mut graph = Graph::new(Box::new(CPUBackend));
    assert!(!graph.is_training()); // Default: inference

    graph.set_training(true);
    assert!(graph.is_training());

    graph.set_training(false);
    assert!(!graph.is_training());
}
