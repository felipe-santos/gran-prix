use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::Tensor;

fn main() -> anyhow::Result<()> {
    println!("Gran-Prix Fused Operations Demo: AddReLU");

    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    let a = gb.val(Tensor::from_shape_vec(&[1, 4], vec![1.0, -2.0, 0.5, -0.1])?);
    let b = gb.val(Tensor::from_shape_vec(&[1, 4], vec![0.5, 0.5, -1.0, 0.2])?);

    // Fused Add+ReLU: max(a + b, 0) in a single pass
    let output = gb.node(gran_prix::graph::OpType::AddReLU, vec![a, b]);

    let result = graph.execute(output)?;
    println!("AddReLU([1.0,-2.0,0.5,-0.1] + [0.5,0.5,-1.0,0.2]):");
    println!("Result: {:?}", result.as_slice()?);
    println!("Expected: [1.5, 0.0, 0.0, 0.1]");

    Ok(())
}
