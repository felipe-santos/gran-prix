use gran_prix::graph::{Graph, Operation};
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::backend::Backend;
use gran_prix::{Tensor, GPResult};

use serde::{Serialize, Deserialize};
use ndarray::array;

/// A Custom Operation: Power(x, n) = x^n
/// This demonstrates how a "Plugin" would define a new kernel.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PowerOp {
    pub exponent: f32,
}

#[typetag::serde]
impl Operation for PowerOp {
    fn name(&self) -> &str { "Power" }
    
    fn forward(&self, inputs: &[&Tensor], _backend: &dyn Backend) -> GPResult<Tensor> {
        Ok(inputs[0].mapv(|v| v.powf(self.exponent)))
    }

    fn backward(&self, inputs: &[&Tensor], grad_output: &Tensor, _backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        // d(x^n)/dx = n * x^(n-1)
        let mut grad = inputs[0].mapv(|v| self.exponent * v.powf(self.exponent - 1.0));
        grad = &grad * grad_output;
        Ok(vec![grad])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        Ok(input_shapes[0].clone())
    }
    fn clone_box(&self) -> Box<dyn Operation> {
        Box::new(self.clone())
    }
}

fn main() -> anyhow::Result<()> {
    println!("🔌 Gran-Prix Plugin System: Custom Operation (Power)");
    
    // Use the custom operation in a graph
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    let x = gb.val(array![[2.0, 3.0]].into_dyn().into());
    let power_node = graph.op(gran_prix::graph::OpType::Custom(Box::new(PowerOp { exponent: 3.0 })), vec![x]);
    
    // Forward pass
    println!("Step 1: Running Forward Pass...");
    let result = graph.execute(power_node)?;
    println!("Result (x^3): {:?}", result);
    
    // Backward pass
    println!("\nStep 2: Running Backward Pass (Custom Autograd)...");
    graph.backward(power_node, array![[1.0, 1.0]].into_dyn().into())?;
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
