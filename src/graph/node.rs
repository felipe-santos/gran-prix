use serde::{Serialize, Deserialize};
use crate::{Tensor, NodeId, GPResult, GPError};
use crate::backend::Backend;

/// A node in the computation graph.
#[derive(Serialize, Deserialize)]
pub enum Node {
    Input(Tensor),
    Param(Tensor), // Trainable parameters
    Op {
        op: Box<dyn Operation>,
        inputs: Vec<NodeId>,
    },
}

impl Node {
    pub fn op(&self) -> Option<&dyn Operation> {
        match self {
            Node::Op { op, .. } => Some(op.as_ref()),
            _ => None,
        }
    }
}

/// A generic operation in the DAG.
#[typetag::serde]
pub trait Operation: std::fmt::Debug {
    fn name(&self) -> &str;
    
    /// Forward pass: Computes output given inputs.
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> GPResult<Tensor>;
    
    /// Backward pass: Computes gradients for inputs given gradient of output.
    /// Returns a vector of gradients corresponding to inputs.
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>>;
    
    /// Returns the expected output shape given input shapes.
    /// Used for validation and setup.
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>>;
}

// --- Concrete Operations ---

#[derive(Serialize, Deserialize)]
pub struct MatMul;
#[typetag::serde]
impl Operation for MatMul {
    fn name(&self) -> &str { "MatMul" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        backend.matmul(&inputs[0], &inputs[1])
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        backend.matmul_backward(&inputs[0], &inputs[1], grad_output)
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        let a = &input_shapes[0];
        let b = &input_shapes[1];
        // Simplified: assumes 2D for now, or handles broadcasting? Backend handles it.
        // MatMul: [M, K] x [K, N] -> [M, N]
        if a[a.len()-1] != b[b.len()-2] {
             return Err(GPError::IncompatibleShapes { expected: vec![a[a.len()-1]], found: vec![b[b.len()-2]] });
        }
        let mut out = a.clone();
        out[a.len()-1] = b[b.len()-1];
        Ok(out)
    }
}

#[derive(Serialize, Deserialize)]
pub struct Conv2D {
    pub kernels: Tensor, // [out_channels, in_channels, kH, kW]
    pub bias: Option<Tensor>, // [out_channels]
    pub stride: (usize, usize),
    pub padding: (usize, usize),
}

#[typetag::serde]
impl Operation for Conv2D {
    fn name(&self) -> &str { "Conv2D" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        backend.conv2d(&inputs[0], &self.kernels, self.bias.as_ref(), self.stride, self.padding)
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        // We only return gradient w.r.t Input here. 
        // Gradients for kernels/bias are stored in the Operation-equivalent Param node?
        // Wait, Conv2D as an Op stores kernels inside itself in this struct?
        // NO. In strict graph, Op should only hold configuration. Parameters should be Inputs.
        // But for this legacy/hybrid struct, we doing this.
        // Actually, if kernels are Params, they should be inputs[1].
        // But here struct has `pub kernels: Tensor`. This implies frozen kernels or implicit params.
        // Ideally, Conv2D Op should take 2 or 3 inputs: Input, Weight, Bias.
        // For now, let's stick to the existing implementation logic in backend.
        
        // Validating backward signature... backend.conv2d_backward returns (grad_input, grad_weight, grad_bias)
        let (g_input, _g_weight, _g_bias) = backend.conv2d_backward(&inputs[0], &self.kernels, self.bias.as_ref(), grad_output, self.stride, self.padding)?;
        
        // If we want to support training kernels, we need to return their grads.
        // But since they are fields of the struct, not inputs, Graph cannot update them automatically via `update_parameters` loop 
        // unless Conv2D is refactored to treat weights as input nodes.
        // Current architecture limitation: "Internal" params in Op.
        Ok(vec![g_input])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        // [N, C, H, W]
        // Output H = (H + 2*pad - kH) / stride + 1
        let input = &input_shapes[0]; // [N, C, H, W]
        let k = self.kernels.shape(); // [OutC, InC, kH, kW]
        
        let h_in = input[2];
        let w_in = input[3];
        let h_out = (h_in + 2 * self.padding.0 - k[2]) / self.stride.0 + 1;
        let w_out = (w_in + 2 * self.padding.1 - k[3]) / self.stride.1 + 1;
        
        Ok(vec![input[0], k[0], h_out, w_out])
    }
}

#[derive(Serialize, Deserialize)]
pub struct MaxPool2D {
    pub kernel_size: (usize, usize),
    pub stride: (usize, usize),
}

#[typetag::serde]
impl Operation for MaxPool2D {
    fn name(&self) -> &str { "MaxPool2D" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        backend.max_pool2d(&inputs[0], self.kernel_size, self.stride)
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        Ok(vec![backend.max_pool2d_backward(&inputs[0], grad_output, self.kernel_size, self.stride)?])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        let input = &input_shapes[0];
        let h_in = input[2];
        let w_in = input[3];
        let h_out = (h_in - self.kernel_size.0) / self.stride.0 + 1;
        let w_out = (w_in - self.kernel_size.1) / self.stride.1 + 1;
        Ok(vec![input[0], input[1], h_out, w_out])
    }
}

#[derive(Serialize, Deserialize)]
pub struct Add;
#[typetag::serde]
impl Operation for Add {
    fn name(&self) -> &str { "Add" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        backend.add(&inputs[0], &inputs[1])
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        let shape_a = inputs[0].shape();
        let shape_b = inputs[1].shape();
        
        // Helper to resolve broadcast dimensions
        let resolve_grad = |target_shape: &[usize], grad: &Tensor| -> GPResult<Tensor> {
            if target_shape == grad.shape() {
                return Ok(grad.clone());
            }
            
            let grad_dims = grad.shape().len();
            let target_dims = target_shape.len();
            let mut axes_to_reduce = Vec::new();
            
            // Reduce extra leading dims
            if grad_dims > target_dims {
                for i in 0..(grad_dims - target_dims) {
                    axes_to_reduce.push(i);
                }
            }
            
            // Check matching trailing dims
            for i in 0..target_dims {
                let g_idx = grad_dims - 1 - i;
                let t_idx = target_dims - 1 - i;
                
                if target_shape[t_idx] == 1 && grad.shape()[g_idx] > 1 {
                    axes_to_reduce.push(g_idx);
                }
            }
            
            if axes_to_reduce.is_empty() {
                 return Ok(grad.clone());
            }
            
            backend.reduce_sum(grad, &axes_to_reduce, true)
                .and_then(|t| {
                    if t.shape().len() != target_shape.len() {
                         let val = t.try_view()?.to_owned().into_shape(target_shape)
                             .map_err(|_e| GPError::IncompatibleShapes { expected: target_shape.to_vec(), found: t.shape().to_vec() })?;
                         Ok(val.into_dyn().into())
                    } else {
                         Ok(t)
                    }
                })
        };

        Ok(vec![
            resolve_grad(shape_a, grad_output)?,
            resolve_grad(shape_b, grad_output)?
        ])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        // Broadcasting logic validation could go here
        Ok(input_shapes[0].clone()) // Simplistic
    }
}

#[derive(Serialize, Deserialize)]
pub struct ReLUOp;
#[typetag::serde]
impl Operation for ReLUOp {
    fn name(&self) -> &str { "ReLU" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        backend.relu(&inputs[0])
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        Ok(vec![backend.relu_backward(&inputs[0], grad_output)?])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        Ok(input_shapes[0].clone())
    }
}

#[derive(Serialize, Deserialize)]
pub struct SigmoidOp;
#[typetag::serde]
impl Operation for SigmoidOp {
    fn name(&self) -> &str { "Sigmoid" }
    fn forward(&self, inputs: &[Tensor], backend: &dyn Backend) -> GPResult<Tensor> {
        backend.sigmoid(&inputs[0])
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        let y = backend.sigmoid(&inputs[0])?; 
        Ok(vec![backend.sigmoid_backward(&y, grad_output)?])
    }
    fn output_shape(&self, input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        Ok(input_shapes[0].clone())
    }
}

#[derive(Serialize, Deserialize)]
pub struct Reshape {
    pub target_shape: Vec<usize>,
}

#[typetag::serde]
impl Operation for Reshape {
    fn name(&self) -> &str { "Reshape" }
    fn forward(&self, inputs: &[Tensor], _backend: &dyn Backend) -> GPResult<Tensor> {
        let mut t = inputs[0].clone();
        t = t.into_shape(self.target_shape.as_slice())?.into_dyn();
        Ok(t)
    }
    fn backward(&self, inputs: &[Tensor], grad_output: &Tensor, _backend: &dyn Backend) -> GPResult<Vec<Tensor>> {
        let original_shape = inputs[0].shape();
        let mut grad = grad_output.clone();
        grad = grad.into_shape(original_shape)?.into_dyn();
        Ok(vec![grad])
    }
    fn output_shape(&self, _input_shapes: &[Vec<usize>]) -> GPResult<Vec<usize>> {
        Ok(self.target_shape.clone())
    }
}
