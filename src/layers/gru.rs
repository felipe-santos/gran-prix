use crate::{Tensor, Layer, NodeId};
use crate::graph::dsl::GraphBuilder;
use serde::{Serialize, Deserialize};
use crate::graph::OpType;

/// A Gated Recurrent Unit (GRU) Cell.
/// Provides temporal memory while mitigating the vanishing gradient problem.
#[derive(Serialize, Deserialize, Debug)]
pub struct GRUCell {
    pub hidden_size: usize,
    pub input_size: usize,
    
    // Update Gate (z)
    pub wz_ih: Tensor, pub bz_ih: Tensor,
    pub wz_hh: Tensor, pub bz_hh: Tensor,
    
    // Reset Gate (r)
    pub wr_ih: Tensor, pub br_ih: Tensor,
    pub wr_hh: Tensor, pub br_hh: Tensor,
    
    // New Memory (n / h_tilde)
    pub wn_ih: Tensor, pub bn_ih: Tensor,
    pub wn_hh: Tensor, pub bn_hh: Tensor,
    
    // Persistent state
    #[serde(skip)]
    pub hidden_state: Option<Tensor>,
    
    // Internal tracker for the state node during forward pass
    #[serde(skip)]
    pub(crate) state_node_id: Option<NodeId>,
}

impl GRUCell {
    pub fn new(input_size: usize, hidden_size: usize) -> Self {
        let init_w = |i, h| Tensor::new_random(&[i, h]);
        let init_b = |h| Tensor::new_zeros(&[1, h]);

        Self {
            hidden_size,
            input_size,
            
            wz_ih: init_w(input_size, hidden_size), bz_ih: init_b(hidden_size),
            wz_hh: init_w(hidden_size, hidden_size), bz_hh: init_b(hidden_size),
            
            wr_ih: init_w(input_size, hidden_size), br_ih: init_b(hidden_size),
            wr_hh: init_w(hidden_size, hidden_size), br_hh: init_b(hidden_size),
            
            wn_ih: init_w(input_size, hidden_size), bn_ih: init_b(hidden_size),
            wn_hh: init_w(hidden_size, hidden_size), bn_hh: init_b(hidden_size),
            
            hidden_state: None,
            state_node_id: None,
        }
    }

    pub fn reset_memory(&mut self) {
        self.hidden_state = None;
    }
}

#[typetag::serde]
impl Layer for GRUCell {
    fn forward(&mut self, input: NodeId, graph: &mut GraphBuilder) -> NodeId {
        let h_prev_tensor = match &self.hidden_state {
            Some(t) => t.clone(),
            None => Tensor::new_zeros(&[1, self.hidden_size]),
        };
        let h_prev = graph.val(h_prev_tensor);

        // --- Update Gate (z_t) ---
        let wz_ih = graph.param(self.wz_ih.clone()); let bz_ih = graph.param(self.bz_ih.clone());
        let z_ih_proj = graph.linear(input, wz_ih, bz_ih);
        let wz_hh = graph.param(self.wz_hh.clone()); let bz_hh = graph.param(self.bz_hh.clone());
        let z_hh_proj = graph.linear(h_prev, wz_hh, bz_hh);
        let z_sum = graph.node(OpType::Add, vec![z_ih_proj, z_hh_proj]);
        let z_t = graph.node(OpType::Sigmoid, vec![z_sum]);

        // --- Reset Gate (r_t) ---
        let wr_ih = graph.param(self.wr_ih.clone()); let br_ih = graph.param(self.br_ih.clone());
        let r_ih_proj = graph.linear(input, wr_ih, br_ih);
        let wr_hh = graph.param(self.wr_hh.clone()); let br_hh = graph.param(self.br_hh.clone());
        let r_hh_proj = graph.linear(h_prev, wr_hh, br_hh);
        let r_sum = graph.node(OpType::Add, vec![r_ih_proj, r_hh_proj]);
        let r_t = graph.node(OpType::Sigmoid, vec![r_sum]);

        // --- New Memory (n_t / h_tilde) ---
        let wn_ih = graph.param(self.wn_ih.clone()); let bn_ih = graph.param(self.bn_ih.clone());
        let n_ih_proj = graph.linear(input, wn_ih, bn_ih);
        let wn_hh = graph.param(self.wn_hh.clone()); let bn_hh = graph.param(self.bn_hh.clone());
        
        let r_times_h = graph.node(OpType::Mul, vec![r_t, h_prev]);
        let n_hh_proj = graph.linear(r_times_h, wn_hh, bn_hh);
        
        let n_sum = graph.node(OpType::Add, vec![n_ih_proj, n_hh_proj]);
        let n_t = graph.node(OpType::Tanh, vec![n_sum]);

        // graph doesn't have a 1-x op directly. We can multiply z_t by -1 and add 1
        let ones_tensor = Tensor::new_ones(&[1, self.hidden_size]);
        let ones = graph.val(ones_tensor);

        let neg_one_tensor = Tensor::from_elem(&[1, 1], -1.0);
        let neg_one = graph.val(neg_one_tensor);
        let neg_z_t = graph.node(OpType::Mul, vec![z_t, neg_one]);
        let one_minus_z = graph.node(OpType::Add, vec![ones, neg_z_t]);
        
        let part1 = graph.node(OpType::Mul, vec![one_minus_z, n_t]);
        let part2 = graph.node(OpType::Mul, vec![z_t, h_prev]);
        
        let h_t = graph.node(OpType::Add, vec![part1, part2]);
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
