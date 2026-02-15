use gran_prix::graph::Graph;
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use ndarray::Array2;
use rand::Rng;
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
    let mut gb = GraphBuilder::new(&mut graph);
    
    // Create some "heavy" matrices
    let mut rng = rand::thread_rng();
    let x_data = Array2::from_shape_fn((500, 500), |_| rng.gen::<f32>());
    let w_data = Array2::from_shape_fn((500, 500), |_| rng.gen::<f32>());
    let b_data = Array2::from_shape_fn((1, 500), |_| rng.gen::<f32>());

    let x = gb.val(x_data);
    let w = gb.param(w_data);
    let b = gb.param(b_data);

    println!("\nStep 1: Executing complex graph...");
    let out = gb.linear(x, w, b);
    let _ = graph.execute(out)?;

    println!("\nStep 2: Running backward pass...");
    let grad_output = Array2::from_elem((500, 500), 1.0);
    graph.backward(out, grad_output)?;

    println!("\n✅ Profiling complete. Check the logs for exact kernel durations!");

    Ok(())
}
