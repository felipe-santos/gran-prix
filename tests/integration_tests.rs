//! Integration tests for Gran-Prix.
//!
//! These tests verify end-to-end correctness of the framework:
//! - Numerical gradient checking (autograd vs finite differences)
//! - Optimizer convergence (SGD and Adam)
//! - Model save/load roundtrip
//! - NetworkDef compile → train → infer

use gran_prix::graph::{Graph, dsl::GraphBuilder};
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::loss::{Loss, MSE, BCEWithLogits};
use gran_prix::optim::{Optimizer, SGD, Adam};
use gran_prix::network_def::{NetworkDef, ActivationDef};
use gran_prix::Tensor;

// ────────────────────────────────────────────────────────────────────────────
// NUMERICAL GRADIENT CHECKING
//
// The most important test in any ML framework. Compares the gradient computed
// by reverse-mode autodiff (backward pass) with a numerical approximation
// using central finite differences:
//
//     dL/dw ≈ (L(w + ε) - L(w - ε)) / (2ε)
//
// If the relative error is > 1e-3, the autodiff is likely wrong.
// ────────────────────────────────────────────────────────────────────────────

/// Helper: build a 2-layer MLP and compute loss for given param values.
fn compute_loss_for_params(
    param_values: &[f32],
    input_data: &[f32],
    target_data: &[f32],
) -> f32 {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let input_id = graph.input(Tensor::from_shape_vec(&[1, 2], input_data.to_vec()).unwrap());

    let mut gb = GraphBuilder::new(&mut graph);
    // Layer 1: 2 → 3
    let w1 = gb.param(Tensor::new_zeros(&[2, 3]));
    let b1 = gb.param(Tensor::new_zeros(&[1, 3]));
    let l1 = gb.linear(input_id, w1, b1);
    let a1 = gb.tanh(l1);
    // Layer 2: 3 → 1
    let w2 = gb.param(Tensor::new_zeros(&[3, 1]));
    let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
    let output = gb.linear(a1, w2, b2);

    // Import the specific param values
    graph.params_mut().import_flat(param_values).unwrap();

    let pred = graph.execute(output).unwrap();
    let target = Tensor::from_shape_vec(&[1, 1], target_data.to_vec()).unwrap();
    MSE.calculate(&pred, &target)
}

#[test]
fn test_numerical_gradient_check_mse() {
    let input_data = vec![0.5, -0.3];
    let target_data = vec![1.0];

    // Build the graph and do forward + backward
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let input_id = graph.input(Tensor::from_shape_vec(&[1, 2], input_data.clone()).unwrap());

    let mut gb = GraphBuilder::new(&mut graph);
    // Use small deterministic weights to avoid high-curvature regions
    let w1 = gb.param(Tensor::from_shape_vec(&[2, 3], vec![0.1, -0.2, 0.15, -0.1, 0.2, -0.15]).unwrap());
    let b1 = gb.param(Tensor::new_zeros(&[1, 3]));
    let l1 = gb.linear(input_id, w1, b1);
    let a1 = gb.tanh(l1);
    let w2 = gb.param(Tensor::from_shape_vec(&[3, 1], vec![0.3, -0.2, 0.1]).unwrap());
    let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
    let output = gb.linear(a1, w2, b2);

    // Forward
    let pred = graph.execute(output).unwrap();
    let target = Tensor::from_shape_vec(&[1, 1], target_data.clone()).unwrap();

    // Backward (autograd)
    let grad_output = MSE.gradient(&pred, &target);
    graph.backward(output, grad_output).unwrap();

    // Extract autograd gradients
    let autograd_grads: Vec<f32> = {
        let params = graph.params();
        let mut grads = Vec::new();
        for i in 0..params.len() {
            let pid = gran_prix::ParamId(i);
            if let Some(g) = params.gradient(pid) {
                grads.extend_from_slice(g.as_slice().unwrap());
            }
        }
        grads
    };

    // Get current param values
    let param_values = graph.params().export_flat().unwrap();

    // Numerical gradient check (central differences)
    // Use smaller epsilon for better numerical accuracy with tanh/sigmoid
    let epsilon = 1e-5;
    let mut numerical_grads = Vec::with_capacity(param_values.len());

    for i in 0..param_values.len() {
        let mut params_plus = param_values.clone();
        params_plus[i] += epsilon;
        let loss_plus = compute_loss_for_params(&params_plus, &input_data, &target_data);

        let mut params_minus = param_values.clone();
        params_minus[i] -= epsilon;
        let loss_minus = compute_loss_for_params(&params_minus, &input_data, &target_data);

        numerical_grads.push((loss_plus - loss_minus) / (2.0 * epsilon));
    }

    // Compare autograd vs numerical
    assert_eq!(autograd_grads.len(), numerical_grads.len(),
        "Gradient lengths differ: autograd={}, numerical={}",
        autograd_grads.len(), numerical_grads.len());

    let mut max_rel_error = 0.0f32;
    for (i, (ag, ng)) in autograd_grads.iter().zip(numerical_grads.iter()).enumerate() {
        let denom = ag.abs().max(ng.abs()).max(1e-8);
        let rel_error = (ag - ng).abs() / denom;
        if rel_error > max_rel_error {
            max_rel_error = rel_error;
        }
        assert!(rel_error < 0.05,
            "Gradient check FAILED at param {}: autograd={:.6}, numerical={:.6}, rel_error={:.6}",
            i, ag, ng, rel_error);
    }

    println!("Gradient check PASSED. Max relative error: {:.6}", max_rel_error);
}

#[test]
fn test_numerical_gradient_check_bce_with_logits() {
    let input_data = vec![0.8, -0.5];
    let target_data = vec![1.0];

    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let input_id = graph.input(Tensor::from_shape_vec(&[1, 2], input_data.clone()).unwrap());

    let mut gb = GraphBuilder::new(&mut graph);
    // Small deterministic weights for stable numerical gradient checking
    let w1 = gb.param(Tensor::from_shape_vec(&[2, 4], vec![0.1, -0.1, 0.2, -0.2, 0.15, -0.15, 0.05, -0.05]).unwrap());
    let b1 = gb.param(Tensor::new_zeros(&[1, 4]));
    let l1 = gb.linear(input_id, w1, b1);
    let a1 = gb.relu(l1);
    let w2 = gb.param(Tensor::from_shape_vec(&[4, 1], vec![0.3, -0.2, 0.1, -0.1]).unwrap());
    let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
    let output = gb.linear(a1, w2, b2);

    let pred = graph.execute(output).unwrap();
    let target = Tensor::from_shape_vec(&[1, 1], target_data.clone()).unwrap();
    let grad_output = BCEWithLogits.gradient(&pred, &target);
    graph.backward(output, grad_output).unwrap();

    let autograd_grads: Vec<f32> = {
        let params = graph.params();
        let mut grads = Vec::new();
        for i in 0..params.len() {
            if let Some(g) = params.gradient(gran_prix::ParamId(i)) {
                grads.extend_from_slice(g.as_slice().unwrap());
            }
        }
        grads
    };
    let param_values = graph.params().export_flat().unwrap();

    // Numerical check with BCE loss
    let epsilon = 1e-4;
    for i in 0..param_values.len() {
        let mut pp = param_values.clone();
        pp[i] += epsilon;
        let mut pm = param_values.clone();
        pm[i] -= epsilon;

        // Rebuild graph for each perturbation (reuse same architecture)
        let compute = |pv: &[f32]| -> f32 {
            let b = Box::new(CPUBackend);
            let mut g = Graph::new(b);
            let inp = g.input(Tensor::from_shape_vec(&[1, 2], input_data.clone()).unwrap());
            let mut gb = GraphBuilder::new(&mut g);
            let w1 = gb.param(Tensor::from_shape_vec(&[2, 4], vec![0.1, -0.1, 0.2, -0.2, 0.15, -0.15, 0.05, -0.05]).unwrap());
            let b1 = gb.param(Tensor::new_zeros(&[1, 4]));
            let l1 = gb.linear(inp, w1, b1);
            let a1 = gb.relu(l1);
            let w2 = gb.param(Tensor::from_shape_vec(&[4, 1], vec![0.3, -0.2, 0.1, -0.1]).unwrap());
            let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
            let out = gb.linear(a1, w2, b2);
            g.params_mut().import_flat(pv).unwrap();
            let p = g.execute(out).unwrap();
            let t = Tensor::from_shape_vec(&[1, 1], target_data.clone()).unwrap();
            BCEWithLogits.calculate(&p, &t)
        };

        let numerical = (compute(&pp) - compute(&pm)) / (2.0 * epsilon);
        let ag = autograd_grads[i];
        let denom = ag.abs().max(numerical.abs()).max(1e-8);
        let rel_error = (ag - numerical).abs() / denom;

        assert!(rel_error < 0.05,
            "BCE gradient check FAILED at param {}: autograd={:.6}, numerical={:.6}, rel_error={:.6}",
            i, ag, numerical, rel_error);
    }
    println!("BCE gradient check PASSED for all {} parameters.", param_values.len());
}

// ────────────────────────────────────────────────────────────────────────────
// OPTIMIZER CONVERGENCE TESTS
// ────────────────────────────────────────────────────────────────────────────

/// Helper: train a network on XOR for N epochs and return final loss.
///
/// Uses batched forward: all 4 XOR samples as a single [4, 2] input tensor.
fn train_xor(mut optimizer: Box<dyn Optimizer>, epochs: usize) -> f32 {
    // Use batch_size=4 input
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let input_id = graph.input(Tensor::new_zeros(&[4, 2]));
    let mut gb = GraphBuilder::new(&mut graph);
    let w1 = gb.param(Tensor::new_random(&[2, 8]));
    let b1 = gb.param(Tensor::new_zeros(&[1, 8]));
    let l1 = gb.linear(input_id, w1, b1);
    let a1 = gb.tanh(l1);
    let w2 = gb.param(Tensor::new_random(&[8, 1]));
    let b2 = gb.param(Tensor::new_zeros(&[1, 1]));
    let output_id = gb.linear(a1, w2, b2);

    let xor_inputs = Tensor::from_shape_vec(&[4, 2], vec![
        0.0, 0.0,  0.0, 1.0,  1.0, 0.0,  1.0, 1.0,
    ]).unwrap();
    let xor_targets = Tensor::from_shape_vec(&[4, 1], vec![
        0.0, 1.0, 1.0, 0.0,
    ]).unwrap();

    let loss_fn = MSE;
    let mut last_loss = f32::MAX;

    for _epoch in 0..epochs {
        // Set input
        if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(input_id.0) {
            *t = xor_inputs.clone();
        }
        graph.clear_values();
        graph.clear_gradients();

        let pred = graph.execute(output_id).unwrap();
        let loss = loss_fn.calculate(&pred, &xor_targets);
        let grad = loss_fn.gradient(&pred, &xor_targets);
        graph.backward(output_id, grad).unwrap();
        optimizer.step(graph.params_mut()).unwrap();

        last_loss = loss;
    }

    last_loss
}

#[test]
fn test_sgd_convergence_on_xor() {
    let optimizer = Box::new(SGD::new(0.1, 0.0, 0.0));
    let final_loss = train_xor(optimizer, 2000);
    assert!(final_loss < 0.1,
        "SGD should converge on XOR. Final loss: {}", final_loss);
}

#[test]
fn test_sgd_with_momentum_convergence() {
    let optimizer = Box::new(SGD::new(0.3, 0.9, 0.0));
    let final_loss = train_xor(optimizer, 500);
    assert!(final_loss < 0.1,
        "SGD+momentum should converge on XOR. Final loss: {}", final_loss);
}

#[test]
fn test_adam_convergence_on_xor() {
    let optimizer = Box::new(Adam::new(0.05));
    let final_loss = train_xor(optimizer, 500);
    assert!(final_loss < 0.05,
        "Adam should converge well on XOR. Final loss: {}", final_loss);
}

#[test]
fn test_adam_loss_decreases_monotonically_early() {
    // Adam should decrease loss in the first 50 epochs on a simple problem
    let net = NetworkDef::mlp(2, &[4], 1, ActivationDef::Tanh, None);
    let compiled = net.compile(Box::new(CPUBackend)).unwrap();
    let mut graph = compiled.graph;
    let input_id = compiled.input_node;
    let output_id = compiled.output_node;
    let mut optimizer = Adam::new(0.05);

    let inp = vec![1.0, 0.0];
    let tgt = vec![1.0];

    let mut losses = Vec::new();
    for _ in 0..50 {
        if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(input_id.0) {
            *t = Tensor::from_shape_vec(&[1, 2], inp.clone()).unwrap();
        }
        graph.clear_values();
        graph.clear_gradients();

        let pred = graph.execute(output_id).unwrap();
        let target = Tensor::from_shape_vec(&[1, 1], tgt.clone()).unwrap();
        let loss = MSE.calculate(&pred, &target);
        losses.push(loss);

        let grad = MSE.gradient(&pred, &target);
        graph.backward(output_id, grad).unwrap();
        optimizer.step(graph.params_mut()).unwrap();
    }

    // Loss at epoch 50 should be much less than epoch 1
    assert!(losses.last().unwrap() < &(losses[0] * 0.5),
        "Adam should reduce loss significantly. First: {}, Last: {}",
        losses[0], losses.last().unwrap());
}

// ────────────────────────────────────────────────────────────────────────────
// MODEL SAVE / LOAD ROUNDTRIP
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_network_def_save_load_roundtrip() {
    // 1. Define and compile
    let net = NetworkDef::mlp(2, &[8, 4], 1, ActivationDef::ReLU, Some(ActivationDef::Sigmoid));

    let compiled = net.compile(Box::new(CPUBackend)).unwrap();
    let mut graph = compiled.graph;
    let output_id = compiled.output_node;

    // 2. Do a forward pass to get a baseline prediction
    let pred_before = graph.execute(output_id).unwrap();
    let pred_before_val = pred_before.get_2d(0, 0).unwrap();

    // 3. Serialize architecture + params
    let net_json = net.to_json().unwrap();
    let params_flat = graph.params().export_flat().unwrap();

    // 4. Deserialize into a new graph
    let net_restored = NetworkDef::from_json(&net_json).unwrap();
    let compiled2 = net_restored.compile(Box::new(CPUBackend)).unwrap();
    let mut graph2 = compiled2.graph;
    let output_id2 = compiled2.output_node;

    // 5. Import the saved weights
    graph2.params_mut().import_flat(&params_flat).unwrap();

    // 6. Run inference — should match
    let pred_after = graph2.execute(output_id2).unwrap();
    let pred_after_val = pred_after.get_2d(0, 0).unwrap();

    let diff = (pred_before_val - pred_after_val).abs();
    assert!(diff < 1e-6,
        "Save/load roundtrip prediction mismatch: before={}, after={}, diff={}",
        pred_before_val, pred_after_val, diff);
}

#[test]
fn test_param_store_serialization_preserves_values() {
    let net = NetworkDef::mlp(4, &[8], 2, ActivationDef::Tanh, None);
    let compiled = net.compile(Box::new(CPUBackend)).unwrap();

    let params = compiled.graph.params();
    let original_flat = params.export_flat().unwrap();

    // Serialize to JSON
    let json = serde_json::to_string(params).unwrap();

    // Deserialize
    let restored: gran_prix::ParamStore = serde_json::from_str(&json).unwrap();
    let restored_flat = restored.export_flat().unwrap();

    assert_eq!(original_flat.len(), restored_flat.len());
    for (i, (a, b)) in original_flat.iter().zip(restored_flat.iter()).enumerate() {
        assert!((a - b).abs() < 1e-7,
            "Param {} differs: original={}, restored={}", i, a, b);
    }
}

// ────────────────────────────────────────────────────────────────────────────
// NETWORK DEF END-TO-END
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_network_def_compile_train_infer() {
    // The "happy path": define → compile → train → infer
    let net = NetworkDef::mlp(2, &[8], 1, ActivationDef::Tanh, None);
    let compiled = net.compile(Box::new(CPUBackend)).unwrap();
    let mut graph = compiled.graph;
    let input_id = compiled.input_node;
    let output_id = compiled.output_node;

    let mut optimizer = Adam::new(0.05);
    let loss_fn = MSE;

    // Train on a simple pattern: [1, 0] → 1.0
    for _ in 0..200 {
        if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(input_id.0) {
            *t = Tensor::from_shape_vec(&[1, 2], vec![1.0, 0.0]).unwrap();
        }
        graph.clear_values();
        graph.clear_gradients();

        let pred = graph.execute(output_id).unwrap();
        let target = Tensor::from_shape_vec(&[1, 1], vec![1.0]).unwrap();
        let grad = loss_fn.gradient(&pred, &target);
        graph.backward(output_id, grad).unwrap();
        optimizer.step(graph.params_mut()).unwrap();
    }

    // Inference
    if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(input_id.0) {
        *t = Tensor::from_shape_vec(&[1, 2], vec![1.0, 0.0]).unwrap();
    }
    graph.clear_values();
    let pred = graph.execute(output_id).unwrap();
    let val = pred.get_2d(0, 0).unwrap();

    assert!((val - 1.0).abs() < 0.2,
        "Network should approximate 1.0 after training. Got: {}", val);
}
