//! Typed errors of the library. The binary wraps them in `anyhow`.

use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Input that violates a contract or a documented precondition.
    #[error("{0}")]
    Invalid(String),
    #[error("cannot access {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid JSON in {what}: {source}")]
    Json {
        what: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("core error: {0}")]
    Core(#[from] gran_prix::GPError),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Builds an [`Error::Invalid`] from a format string.
#[macro_export]
macro_rules! invalid {
    ($($arg:tt)*) => { $crate::error::Error::Invalid(format!($($arg)*)) };
}

/// `std::fs` helpers that name the offending path.
pub fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(|source| Error::Io { path: path.display().to_string(), source })
}

pub fn read_text(path: &Path) -> Result<String> {
    std::fs::read_to_string(path).map_err(|source| Error::Io { path: path.display().to_string(), source })
}

pub fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes).map_err(|source| Error::Io { path: path.display().to_string(), source })
}

pub fn create_dir_all(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).map_err(|source| Error::Io { path: path.display().to_string(), source })
}

pub fn parse_json<T: serde::de::DeserializeOwned>(text: &str, what: &str) -> Result<T> {
    serde_json::from_str(text).map_err(|source| Error::Json { what: what.to_string(), source })
}
