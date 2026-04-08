use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::Tensor;

#[test]
fn test_branching_and_merging_gradients() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    // Graph Topology (Residual-like):
    //    x ---[Path A: Identity]---+
    //      \                      |
    //       --[Path B: ReLU]------+--- y = (x) + ReLU(x)

    let x = gb.param(Tensor::from_shape_vec(&[1, 2], vec![-1.0, 2.0]).unwrap());
    let path_b = gb.relu(x);
    let y = gb.add(x, path_b);

    let result = graph.execute(y).unwrap();
    // Path A: [-1, 2]
    // Path B: [0, 2]
    // Y: [-1, 4]
    assert_eq!(result, Tensor::from_shape_vec(&[1, 2], vec![-1.0, 4.0]).unwrap());

    // Backward (grad_out = [1, 1])
    graph.backward(y, Tensor::from_shape_vec(&[1, 2], vec![1.0, 1.0]).unwrap()).unwrap();

    // Gradient computation:
    // dy/dx = d(x + ReLU(x))/dx = 1 + d(ReLU(x))/dx
    // For x = -1: d(ReLU)/dx = 0 -> dy/dx = 1 + 0 = 1
    // For x = 2: d(ReLU)/dx = 1 -> dy/dx = 1 + 1 = 2
    let grad_x = graph.get_gradient(x).unwrap();
    assert_eq!(*grad_x, Tensor::from_shape_vec(&[1, 2], vec![1.0, 2.0]).unwrap());
    println!("Branching gradient accumulation verified.");
}

#[test]
fn test_diamond_topology() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    // Diamond Topology:
    //      x
    //    /   \
    //   a     b
    //    \   /
    //      y

    let x = gb.param(Tensor::from_shape_vec(&[1, 2], vec![1.0, 1.0]).unwrap());
    let a = gb.relu(x);
    let b = gb.sigmoid(x);
    let y = gb.add(a, b);

    graph.execute(y).unwrap();
    graph.backward(y, Tensor::from_shape_vec(&[1, 2], vec![1.0, 1.0]).unwrap()).unwrap();
    // Grad should be d(ReLU)/dx + d(Sigmoid)/dx
    // For x=1: d(ReLU)/dx = 1.0
    // d(Sigmoid)/dx at x=1 is sigmoid(1)*(1-sigmoid(1)) = 0.731 * 0.269 = 0.1966
    let grad_x = graph.get_gradient(x).unwrap();
    let expected_at_1 = 1.0 + 0.7310586 * (1.0 - 0.7310586);
    let grad_val = grad_x.get_flat(0).unwrap();
    assert!((grad_val - expected_at_1).abs() < 1e-6);
}

#[test]
fn test_deep_sequential_chain() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    // Deep chain: 10 ReLU operations
    let mut curr = gb.param(Tensor::from_shape_vec(&[1, 2], vec![1.0, -1.0]).unwrap());
    let start_node = curr;
    for _ in 0..10 {
        curr = gb.relu(curr);
    }

    let res = graph.execute(curr).unwrap();
    assert_eq!(res, Tensor::from_shape_vec(&[1, 2], vec![1.0, 0.0]).unwrap());

    graph.backward(curr, Tensor::from_shape_vec(&[1, 2], vec![1.0, 1.0]).unwrap()).unwrap();
    let grad = graph.get_gradient(start_node).unwrap();
    assert_eq!(*grad, Tensor::from_shape_vec(&[1, 2], vec![1.0, 0.0]).unwrap());
}
