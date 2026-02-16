use gran_prix::graph::{Graph, Operation};
use gran_prix::graph::dsl::GraphBuilder;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::{Tensor, GPResult};

use serde::{Serialize, Deserialize};
use ndarray::array;

#[derive(Serialize, Deserialize, Clone, Debug)]
struct CustomAddOp;

#[typetag::serde]
impl Operation for CustomAddOp {
    fn name(&self) -> &str { "CustomAdd" }
    fn forward(&self, inputs: &[&Tensor], _backend: &dyn gran_prix::backend::Backend) -> GPResult<Tensor> {
        Ok(inputs[0] + inputs[1])
    }
    fn backward(&self, _inputs: &[&Tensor], grad_output: &Tensor, _backend: &dyn gran_prix::backend::Backend) -> GPResult<Vec<Tensor>> {
        Ok(vec![grad_output.clone(), grad_output.clone()])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        Ok(input_shapes[0].clone())
    }
    fn clone_box(&self) -> Box<dyn Operation> {
        Box::new(self.clone())
    }
}

#[test]
fn test_full_persistence_with_custom_op() {
    let backend = Box::new(CPUBackend);
    let mut graph = Graph::new(backend);
    let mut gb = GraphBuilder::new(&mut graph);
    
    let x = gb.val(array![[1.0, 1.0]].into_dyn().into());
    let y = gb.val(array![[2.0, 2.0]].into_dyn().into());
    let node = graph.op(Box::new(CustomAddOp), vec![x, y]);
    
    let result = graph.execute(node).unwrap();
    assert_eq!(result, array![[3.0, 3.0]].into_dyn().into());
    
    // Serialize
    let json = serde_json::to_string(&graph).unwrap();
    
    // Deserialize
    let mut new_graph: Graph = serde_json::from_str(&json).unwrap();
    new_graph.set_backend(Box::new(CPUBackend));
    
    let result_loaded = new_graph.execute(node).unwrap();
    assert_eq!(result_loaded, array![[3.0, 3.0]].into_dyn().into());
}
