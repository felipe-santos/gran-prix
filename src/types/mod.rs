use serde::{Serialize, Deserialize};
use ndarray::{IxDyn, Dimension};

/// Unique identifier for a node in the computation graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NodeId(pub usize);

/// Represents the shape of a tensor.
/// Wrapper around IxDyn to provide a more domain-specific API.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Shape(pub IxDyn);

impl Shape {
    pub fn from_slice(dims: &[usize]) -> Self {
        Self(IxDyn(dims))
    }

    pub fn as_slice(&self) -> &[usize] {
        self.0.slice()
    }

    pub fn ndim(&self) -> usize {
        self.0.ndim()
    }

    pub fn size(&self) -> usize {
        self.0.slice().iter().product()
    }

    pub fn len(&self) -> usize {
        self.0.slice().iter().product()
    }
}

impl From<IxDyn> for Shape {
    fn from(ix: IxDyn) -> Self {
        Self(ix)
    }
}

impl From<Vec<usize>> for Shape {
    fn from(dims: Vec<usize>) -> Self {
        Self(IxDyn(&dims))
    }
}

/// Identifica um dispositivo físico (ex: GPU 0, CPU).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Device {
    Cpu,
    #[cfg(feature = "cuda")]
    Cuda(usize),
}
