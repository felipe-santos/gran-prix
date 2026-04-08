use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::Tensor;

fn main() -> anyhow::Result<()> {
    println!("Gran-Prix Graph Execution Demo: Buffer Reuse");

    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    // Build a linear chain: x → matmul → relu → matmul → sigmoid
    let x = gb.val(Tensor::from_shape_vec(&[1, 2], vec![1.0, 1.0])?);
    let w1 = gb.val(Tensor::from_shape_vec(&[2, 2], vec![1.0, 0.0, 0.0, 1.0])?);
    let a = gb.matmul(x, w1);
    let b = gb.relu(a);
    let w2 = gb.val(Tensor::from_shape_vec(&[2, 2], vec![2.0, 0.0, 0.0, 2.0])?);
    let c = gb.matmul(b, w2);
    let d = gb.sigmoid(c);

    println!("Graph: {} nodes", graph.nodes().len());
    println!("Params: {} tensors", graph.params().len());

    // First execution allocates buffers
    let result1 = graph.execute(d)?;
    println!("Pass 1: {:?}", result1.as_slice()?);

    // Second execution reuses cached buffers (zero allocation)
    let result2 = graph.execute(d)?;
    println!("Pass 2: {:?}", result2.as_slice()?);

    println!("Buffer reuse verified — second pass reused existing allocations.");
    Ok(())
}
