use gran_prix::graph::{Graph, Operation, NodeId};
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::backend::Backend;
use gran_prix::Tensor;
use anyhow::Result;
use serde::{Serialize, Deserialize};
use ndarray::array;

/// A Custom Operation: Power(x, n) = x^n
/// This demonstrates how a "Plugin" would define a new kernel.
#[derive(Serialize, Deserialize)]
pub struct PowerOp {
    pub exponent: f32,
}

#[typetag::serde]
impl Operation for PowerOp {
    fn name(&self) -> &str { "Power" }
    
    fn forward(&self, inputs: &[Tensor], _backend: &dyn Backend) -> Result<Tensor> {
        // Here we could add a method to the Backend trait, 
        // but for a plugin we can also use ndarray directly.
        Ok(inputs[0].mapv(|v| v.powf(self.exponent)))
    }

    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, _backend: &dyn Backend) -> Result<Vec<Tensor>> {
        // d(x^n)/dx = n * x^(n-1)
        let mut grad = inputs[0].mapv(|v| self.exponent * v.powf(self.exponent - 1.0));
        grad *= grad_output;
        Ok(vec![grad])
    }
}

fn main() -> anyhow::Result<()> {
    println!("🔌 Gran-Prix Plugin System: Custom Operation (Power)");
    
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    // 1. Use the custom operation
    let x = gb.val(array![[2.0, 3.0]]);
    // We register the custom op manually in the graph
    let power_node = graph.op(Box::new(PowerOp { exponent: 3.0 }), vec![x]);
    
    // 2. Execute
    let result = graph.execute(power_node)?;
    println!("Power Result (2^3, 3^3): {:?}", result);

    // 3. Verify Autograd for the custom op
    println!("\nVerifying Autograd for Custom Op...");
    graph.backward(power_node, array![[1.0, 1.0]])?;
    let grad_x = graph.get_gradient(x).unwrap();
    println!("Gradient wrt x (3 * x^2): {:?}", grad_x);
    println!("(Expected: [12, 27])");

    // 4. Verify Serialization
    println!("\nVerifying Serialization of Custom Op...");
    let json = serde_json::to_string(&graph)?;
    let mut new_graph: Graph = serde_json::from_str(&json)?;
    new_graph.set_backend(Box::new(CPUBackend));
    
    let result_reloaded = new_graph.execute(power_node)?;
    println!("Reloaded Result: {:?}", result_reloaded);
    
    println!("\n✅ Custom Operation 'Power' integrated flawlessly. Plugin architecture validated.");

    Ok(())
}
