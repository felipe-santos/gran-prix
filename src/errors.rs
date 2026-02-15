use thiserror::Error;

#[derive(Error, Debug)]
pub enum GPError {
    #[error("Incompatible shapes: expected {expected:?}, got {found:?}")]
    IncompatibleShapes {
        expected: Vec<usize>,
        found: Vec<usize>,
    },
    #[error("Standard IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Backend error: {0}")]
    Backend(String),
    #[error("Unknown error occurred")]
    Unknown,
}

pub type GPResult<T> = Result<T, GPError>;
