use crate::{Tensor, Layer, NodeId};
use crate::graph::dsl::GraphBuilder;
use crate::layers::make_param_name;
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
    
    // Persistent state — value of h_{t-1} between forwards.
    #[serde(skip)]
    pub hidden_state: Option<Tensor>,

    // Internal tracker for the state output node (h_t) — set during
    // `forward`. After execute, the graph value cache holds the new
    // hidden state at this node id.
    #[serde(skip)]
    pub(crate) state_node_id: Option<NodeId>,

    // Internal tracker for the previous-state input node (h_{t-1}) —
    // set during `forward`. A recurrence-aware caller writes the new
    // hidden state into this input node between forwards so the next
    // forward sees the updated state. See `Layer::prev_state_input`.
    #[serde(skip)]
    pub(crate) prev_state_input_id: Option<NodeId>,

    /// Optional prefix for parameter naming. See `Linear::name_prefix`.
    #[serde(default)]
    pub name_prefix: String,
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
            prev_state_input_id: None,
            name_prefix: String::new(),
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
        // h_prev is an `Input` node (mutable tensor). The recurrence-aware
        // caller (`CompiledNetwork::update_states`) writes h_t back into
        // this input between forwards. Track its id for that write.
        let h_prev = graph.val(h_prev_tensor);
        self.prev_state_input_id = Some(h_prev);

        let np = |role: &str| make_param_name(&self.name_prefix, role);

        // --- Update Gate (z_t) ---
        let wz_ih = graph.named_param(self.wz_ih.clone(), &np("wz_ih"));
        let bz_ih = graph.named_param(self.bz_ih.clone(), &np("bz_ih"));
        let z_ih_proj = graph.linear(input, wz_ih, bz_ih);
        let wz_hh = graph.named_param(self.wz_hh.clone(), &np("wz_hh"));
        let bz_hh = graph.named_param(self.bz_hh.clone(), &np("bz_hh"));
        let z_hh_proj = graph.linear(h_prev, wz_hh, bz_hh);
        let z_sum = graph.node(OpType::Add, vec![z_ih_proj, z_hh_proj]);
        let z_t = graph.node(OpType::Sigmoid, vec![z_sum]);

        // --- Reset Gate (r_t) ---
        let wr_ih = graph.named_param(self.wr_ih.clone(), &np("wr_ih"));
        let br_ih = graph.named_param(self.br_ih.clone(), &np("br_ih"));
        let r_ih_proj = graph.linear(input, wr_ih, br_ih);
        let wr_hh = graph.named_param(self.wr_hh.clone(), &np("wr_hh"));
        let br_hh = graph.named_param(self.br_hh.clone(), &np("br_hh"));
        let r_hh_proj = graph.linear(h_prev, wr_hh, br_hh);
        let r_sum = graph.node(OpType::Add, vec![r_ih_proj, r_hh_proj]);
        let r_t = graph.node(OpType::Sigmoid, vec![r_sum]);

        // --- New Memory (n_t / h_tilde) ---
        let wn_ih = graph.named_param(self.wn_ih.clone(), &np("wn_ih"));
        let bn_ih = graph.named_param(self.bn_ih.clone(), &np("bn_ih"));
        let n_ih_proj = graph.linear(input, wn_ih, bn_ih);
        let wn_hh = graph.named_param(self.wn_hh.clone(), &np("wn_hh"));
        let bn_hh = graph.named_param(self.bn_hh.clone(), &np("bn_hh"));
        
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

    fn set_name_prefix(&mut self, prefix: String) {
        self.name_prefix = prefix;
    }

    fn prev_state_input(&self) -> Option<NodeId> {
        self.prev_state_input_id
    }
}
