//! Tests the exact execution path used by the WASM NeuralBrain.

use gran_prix::backend::cpu::CPUBackend;
use gran_prix::network_def::NetworkDef;
use gran_prix::layers::ActivationType;
use gran_prix::Tensor;

#[test]
fn test_wasm_brain_execution_path() {
    // Same as NeuralBrain::new(0, 4, vec![8], 2)
    let net = NetworkDef::mlp(4, &[8], 2, ActivationType::ReLU, Some(ActivationType::Sigmoid));
    let compiled = net.compile(Box::new(CPUBackend)).unwrap();
    let input_node = compiled.input_node.0;
    let output_node = compiled.output_node.0;
    let mut graph = compiled.graph;

    // Override weights with alternating pattern (like brain does)
    {
        let params = graph.params_mut();
        let mut flat = params.export_flat().unwrap();
        for (i, val) in flat.iter_mut().enumerate() {
            let sign = if i % 2 == 0 { 1.0 } else { -1.0 };
            *val = sign * 0.1;
        }
        params.import_flat(&flat).unwrap();
    }

    // === Test 1: Forward pass produces valid outputs ===
    let inputs = vec![0.5, -0.3, 0.8, -0.1];
    if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(input_node) {
        *t = Tensor::from_shape_vec(&[1, 4], inputs.clone()).unwrap();
    }

    graph.sync_params().unwrap();
    let output_id = gran_prix::NodeId(output_node);
    let order = graph.topological_sort(output_id).unwrap();
    for node_id in &order {
        graph.execute_single_node(*node_id).unwrap();
    }

    let out: Vec<f32> = {
        let r = graph.values().get(output_node).and_then(|t| t.as_ref()).unwrap();
        r.as_slice().unwrap().to_vec()
    };

    // Outputs should be in [0,1] (sigmoid)
    assert!(out[0] >= 0.0 && out[0] <= 1.0, "out[0] = {}", out[0]);
    assert!(out[1] >= 0.0 && out[1] <= 1.0, "out[1] = {}", out[1]);

    // === Test 2: Different inputs → different outputs ===
    if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(input_node) {
        *t = Tensor::from_shape_vec(&[1, 4], vec![-0.5, 0.3, -0.8, 0.1]).unwrap();
    }
    graph.sync_params().unwrap();
    for node_id in &order {
        graph.execute_single_node(*node_id).unwrap();
    }
    let out2: Vec<f32> = {
        let r = graph.values().get(output_node).and_then(|t| t.as_ref()).unwrap();
        r.as_slice().unwrap().to_vec()
    };
    let diff = (out[0] - out2[0]).abs() + (out[1] - out2[1]).abs();
    assert!(diff > 0.0001, "Different inputs must give different outputs, diff={}", diff);

    // === Test 3: Mutation changes output (evolution works) ===
    {
        let params = graph.params_mut();
        let mut flat = params.export_flat().unwrap();
        flat[0] += 0.5;
        params.import_flat(&flat).unwrap();
    }

    if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(input_node) {
        *t = Tensor::from_shape_vec(&[1, 4], inputs).unwrap();
    }
    graph.sync_params().unwrap();
    for node_id in &order {
        graph.execute_single_node(*node_id).unwrap();
    }
    let out3: Vec<f32> = {
        let r = graph.values().get(output_node).and_then(|t| t.as_ref()).unwrap();
        r.as_slice().unwrap().to_vec()
    };
    let diff_mut = (out[0] - out3[0]).abs() + (out[1] - out3[1]).abs();
    assert!(diff_mut > 0.001, "Mutation must change output, diff={}", diff_mut);
}

#[test]
fn test_wasm_population_compute_evolve_cycle() {
    // Simulate Population: N brains, compute all, evolve
    let n_agents = 5;
    let num_inputs = 4;
    let num_outputs = 2;
    let hidden = vec![8usize];

    // Create N brains
    let mut graphs = Vec::new();
    let mut input_nodes = Vec::new();
    let mut output_nodes = Vec::new();

    for i in 0..n_agents {
        let net = NetworkDef::mlp(num_inputs, &hidden, num_outputs,
            ActivationType::ReLU, Some(ActivationType::Sigmoid));
        let compiled = net.compile(Box::new(CPUBackend)).unwrap();
        let mut graph = compiled.graph;

        // Unique weights per agent
        let params = graph.params_mut();
        let mut flat = params.export_flat().unwrap();
        for (j, val) in flat.iter_mut().enumerate() {
            let sign = if (j + i) % 2 == 0 { 1.0 } else { -1.0 };
            *val = sign * 0.1;
        }
        params.import_flat(&flat).unwrap();

        input_nodes.push(compiled.input_node);
        output_nodes.push(compiled.output_node);
        graphs.push(graph);
    }

    // Compute all agents
    let sensor_data = vec![0.5, -0.3, 0.8, -0.1];
    let mut outputs = Vec::new();

    for (idx, graph) in graphs.iter_mut().enumerate() {
        if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(input_nodes[idx].0) {
            *t = Tensor::from_shape_vec(&[1, num_inputs], sensor_data.clone()).unwrap();
        }
        let result = graph.execute(output_nodes[idx]).unwrap();
        outputs.push(result.as_slice().unwrap().to_vec());
    }

    // Different seeds should produce different outputs
    let mut all_same = true;
    for i in 1..n_agents {
        if outputs[i] != outputs[0] {
            all_same = false;
            break;
        }
    }
    assert!(!all_same, "Agents with different seeds must produce different outputs");

    // Simulate evolution: best agent's weights → all agents
    let best_flat = graphs[0].params().export_flat().unwrap();
    for graph in &mut graphs[1..] {
        graph.params_mut().import_flat(&best_flat).unwrap();
    }

    // After evolution, all agents should produce same output (same weights)
    let mut outputs_after = Vec::new();
    for (idx, graph) in graphs.iter_mut().enumerate() {
        if let Some(gran_prix::graph::Node::Input(ref mut t)) = graph.nodes_mut().get_mut(input_nodes[idx].0) {
            *t = Tensor::from_shape_vec(&[1, num_inputs], sensor_data.clone()).unwrap();
        }
        graph.clear_values();
        let result = graph.execute(output_nodes[idx]).unwrap();
        outputs_after.push(result.as_slice().unwrap().to_vec());
    }

    for i in 1..n_agents {
        assert_eq!(outputs_after[i], outputs_after[0],
            "After weight import, all agents must produce identical output");
    }
}
