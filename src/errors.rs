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
    #[error("Corrupted Memory: expected magic {expected:08X}, found {found:08X}")]
    CorruptedMemory { expected: u32, found: u32 },
    #[error("Re-entrant call detected: component is already in compute mode")]
    ReentrancyError,
    #[error("Weights array length mismatch: expected {expected}, found {found}")]
    WeightLengthMismatch { expected: usize, found: usize },
    #[error("Invalid population size: {0}")]
    PopulationSizeError(usize),
    #[error("Array length mismatch: expected {expected}, found {found}")]
    ArrayLengthMismatch { expected: usize, found: usize },
    #[error("Empty population: cannot perform operation")]
    EmptyPopulation,
    #[error("Evolution failure: {0}")]
    EvolutionError(String),
}

pub type GPResult<T> = Result<T, GPError>;
