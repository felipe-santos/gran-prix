use gran_prix::graph::Graph;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::{model, linear};
use ndarray::array;
use tracing_subscriber::fmt::format::FmtSpan;

fn main() -> anyhow::Result<()> {
    // 1. Initialize professional tracing subscriber with span durations
    tracing_subscriber::fmt()
        .with_span_events(FmtSpan::CLOSE)
        .with_max_level(tracing::Level::INFO)
        .init();

    println!("📊 Gran-Prix Professional Observability: Performance Tracing");
    
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    
    let out = model!(&mut graph, g => {
        let x = g.val(array![[0.1, 0.2, 0.3, 0.4]].into_dyn());
        let w = g.param(ndarray::Array2::zeros((4, 10)).into_dyn());
        let b = g.param(ndarray::Array2::zeros((1, 10)).into_dyn());
        linear!(g, x, w, b)
    });

    // Run forward and backward to see tracing in action
    let _res = graph.execute(out)?;
    
    let grad_output = ndarray::Array2::ones((1, 10)).into_dyn();
    graph.backward(out, grad_output)?;

    println!("\n✅ Profiling complete. Check the logs for exact kernel durations!");

    Ok(())
}
