use gran_prix::graph::{Graph, Operation};
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::backend::Backend;
use gran_prix::{Tensor, GPResult};

use serde::{Serialize, Deserialize};

/// A Custom Operation: Power(x, n) = x^n
/// Demonstrates how to extend the framework with user-defined ops.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PowerOp {
    pub exponent: f32,
}

#[typetag::serde]
impl Operation for PowerOp {
    fn name(&self) -> &str { "Power" }

    fn forward(&self, inputs: &[&Tensor], _backend: &dyn Backend, _training: bool, _rng_seed: u64) -> GPResult<Tensor> {
        Ok(inputs[0].mapv(|v| v.powf(self.exponent)))
    }

    fn backward(&self, inputs: &[&Tensor], _output: Option<&Tensor>, grad_output: &Tensor, _backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
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
    println!("Gran-Prix: Custom Operation (Power)");

    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);

    let x = gb.val(Tensor::from_shape_vec(&[1, 2], vec![2.0, 3.0])?);
    let power_node = graph.op(gran_prix::graph::OpType::Custom(Box::new(PowerOp { exponent: 3.0 })), vec![x]);

    let result = graph.execute(power_node)?;
    println!("Power(x, 3): {:?}", result.as_slice()?);

    graph.backward(power_node, Tensor::from_shape_vec(&[1, 2], vec![1.0, 1.0])?)?;
    let grad_x = graph.get_gradient(x).unwrap();
    println!("d/dx (3*x^2): {:?}", grad_x.as_slice()?);
    println!("Expected: [12, 27]");

    Ok(())
}
