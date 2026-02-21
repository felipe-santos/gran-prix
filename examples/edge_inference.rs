use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::{GPResult, Tensor};
use ndarray::array;

fn main() -> GPResult<()> {
    println!("🚀 Edge Inference Demo");

    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    // Inputs
    let input = gb.val(array![[0.5, 0.1]].into_dyn().into());

    // Model Definition
    // layer 1: Linear(2->4) -> ReLU
    let w1 = gb.param(Tensor::new_random(&[2, 4]));
    let b1 = gb.param(Tensor::new_zeros(&[4]));
    let l1 = gb.matmul(input, w1);
    let l1_bias = gb.add(l1, b1);
    let h1 = gb.relu(l1_bias);

    // layer 2: Linear(4->1) -> Sigmoid
    let w2 = gb.param(Tensor::new_random(&[4, 1]));
    let b2 = gb.param(Tensor::new_zeros(&[1]));
    let l2 = gb.matmul(h1, w2);
    let l2_bias = gb.add(l2, b2);
    let output = gb.sigmoid(l2_bias);

    // Execution
    let result = graph.execute(output)?;
    println!("Inference Result: {:?}", result);
    
    Ok(())
}
