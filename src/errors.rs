use thiserror::Error;

#[derive(Error, Debug)]
pub enum GPError {
    #[error("Incompatible shapes: expected {expected:?} (len={exp_len}), found {found:?} (len={found_len})")]
    IncompatibleShapes { expected: Vec<usize>, found: Vec<usize>, exp_len: usize, found_len: usize },
    #[error("Device mismatch: tensor is on {0:?} but operation requires another device")]
    DeviceMismatch(String),
    #[error("Tensor error: {0}")]
    TensorError(String),
    #[error("Backend error: {0}")]
    BackendError(String),
    #[error("Backend not initialized. Call set_backend() before execution.")]
    BackendNotInitialized,
    #[error("Serialization error: {0}")]
    SerializationError(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Inference error: {0}")]
    InferenceError(String),
    #[error("Operation not implemented: {0}")]
    NotImplemented(String),
    #[error("Unknown error: {0}")]
    Unknown(String),
}

pub type GPResult<T> = Result<T, GPError>;
