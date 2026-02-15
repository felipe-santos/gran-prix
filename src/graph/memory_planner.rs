use crate::graph::{Graph, Node, NodeId};
use anyhow::Result;
use std::collections::{HashMap, HashSet};

/// Plans memory reuse for the computation graph.
pub struct MemoryPlanner {
    /// Maps node index to physical buffer index
    pub plan: Vec<Option<usize>>,
    /// Total buffers required
    pub buffer_count: usize,
}

impl MemoryPlanner {
    pub fn plan(graph: &Graph) -> Result<Self> {
        let node_count = graph.nodes().len();
        let mut liveness = vec![0; node_count]; // Last node index that uses this tensor
        
        // 1. Analyze Liveness: Find the last use of each node
        for (i, node) in graph.nodes().iter().enumerate() {
            if let Node::Op { inputs, .. } = node {
                for input in inputs {
                    liveness[input.0] = i;
                }
            }
        }

        // 2. Greedy Buffer Allocation
        let mut plan = vec![None; node_count];
        let mut free_buffers: Vec<usize> = Vec::new();
        let mut active_buffers: HashMap<usize, usize> = HashMap::new(); // buffer_idx -> node_idx
        let mut buffer_count = 0;

        for i in 0..node_count {
            // Check for buffers that can be freed BEFORE allocating for node i
            // Actually, we can't free inputs of node i until AFTER we compute node i.
            
            // Allocate buffer for node i
            let buf_idx = if let Some(free_idx) = free_buffers.pop() {
                free_idx
            } else {
                let new_idx = buffer_count;
                buffer_count += 1;
                new_idx
            };

            plan[i] = Some(buf_idx);
            active_buffers.insert(buf_idx, i);

            // Free buffers whose tensors are no longer needed
            // A tensor is no longer needed after its last use (liveness[idx] == i)
            // We check this for all active buffers.
            let mut to_remove = Vec::new();
            for (&bi, &ni) in &active_buffers {
                if liveness[ni] <= i {
                    to_remove.push(bi);
                }
            }
            
            for bi in to_remove {
                active_buffers.remove(&bi);
                free_buffers.push(bi);
            }
        }

        println!("[MemoryPlanner] Reduced {} tensors into {} recycled buffers.", node_count, buffer_count);
        Ok(Self { plan, buffer_count })
    }
}
