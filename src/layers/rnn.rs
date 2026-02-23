use crate::{Tensor, Layer, NodeId};
use crate::graph::dsl::GraphBuilder;
use serde::{Serialize, Deserialize};

/// A standard Recurrent Neural Network (RNN) Cell.
/// Computes: h_t = tanh(W_ih * x_t + b_ih + W_hh * h_{t-1} + b_hh)
#[derive(Serialize, Deserialize, Debug)]
pub struct RNNCell {
    pub hidden_size: usize,
    pub input_size: usize,
    // Weights and biases for input to hidden
    pub weight_ih: Tensor,
    pub bias_ih: Tensor,
    // Weights and biases for hidden to hidden
    pub weight_hh: Tensor,
    pub bias_hh: Tensor,
    
    // Persistent state
    #[serde(skip)]
    pub hidden_state: Option<Tensor>,
    
    // Internal tracker for the state node during forward pass
    #[serde(skip)]
    pub(crate) state_node_id: Option<NodeId>,
}

impl RNNCell {
    pub fn new(input_size: usize, hidden_size: usize) -> Self {
        let weight_ih = Tensor::new_random(&[input_size, hidden_size]);
        let bias_ih = Tensor::new_zeros(&[1, hidden_size]);
        
        let weight_hh = Tensor::new_random(&[hidden_size, hidden_size]);
        let bias_hh = Tensor::new_zeros(&[1, hidden_size]);
        
        Self {
            hidden_size,
            input_size,
            weight_ih,
            bias_ih,
            weight_hh,
            bias_hh,
            hidden_state: None,
            state_node_id: None,
        }
    }

    /// Explicitly zeroes out the memory of the cell.
    pub fn reset_memory(&mut self) {
        self.hidden_state = None;
    }
}

#[typetag::serde]
impl Layer for RNNCell {
    fn forward(&mut self, input: NodeId, graph: &mut GraphBuilder) -> NodeId {
        let w_ih = graph.param(self.weight_ih.clone());
        let b_ih = graph.param(self.bias_ih.clone());
        
        // 1. Input transformation: x_t * W_ih + b_ih
        let ih_proj = graph.linear(input, w_ih, b_ih);
        
        // 2. Hidden transformation: W_hh * h_{t-1} + b_hh
        let w_hh = graph.param(self.weight_hh.clone());
        let b_hh = graph.param(self.bias_hh.clone());
        
        let h_prev_tensor = match &self.hidden_state {
            Some(t) => t.clone(),
            None => Tensor::new_zeros(&[1, self.hidden_size]),
        };
        
        // We inject the previous hidden state as a "Val" (constant for this step)
        let h_prev_node = graph.val(h_prev_tensor);
        let hh_proj = graph.linear(h_prev_node, w_hh, b_hh);
        
        // 3. Combine: ih_proj + hh_proj
        use crate::graph::OpType;
        let combined = graph.node(OpType::Add, vec![ih_proj, hh_proj]);
        
        // 4. Activation: tanh(combined)
        let h_t = graph.node(OpType::Tanh, vec![combined]);
        
        // We return the output of the cell (h_t). 
        // The calling code (e.g., `NeuralBrain::compute`) is responsible for reading 
        // the evaluated tensor from h_t and writing it back to `self.hidden_state` 
        // for the next frame. We cannot do this here since this is just the graph building phase.
        
        self.state_node_id = Some(h_t);
        h_t
    }

    fn state_node(&self) -> Option<NodeId> {
        self.state_node_id
    }

    fn update_state(&mut self, tensor: Tensor) {
        self.hidden_state = Some(tensor);
    }
    
    fn reset_state(&mut self) {
        self.reset_memory();
    }
}
