use ndarray::ArrayD;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
#[cfg(feature = "cuda")]
use std::sync::Arc;
#[cfg(feature = "cuda")]
use cudarc::driver::{LaunchAsync};

#[derive(Clone, Debug)]
pub enum Storage {
    Cpu(ArrayD<f32>),
    #[cfg(feature = "cuda")]
    Cuda(Arc<cudarc::driver::CudaSlice<f32>>),
}

// Manual Serialize/Deserialize for Storage because CudaSlice doesn't support it.
// We always save/load from CPU for persistence.
impl Serialize for Storage {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where S: Serializer {
        match self {
            Storage::Cpu(data) => data.serialize(serializer),
            #[cfg(feature = "cuda")]
            Storage::Cuda(slice) => {
                // For serialization, we must move to host
                let data = slice.device().dtoh_sync_copy(slice.as_ref())
                    .map_err(serde::ser::Error::custom)?;
                serializer.serialize_newtype_variant("Storage", 0, "Cpu", &data)
            }
        }
    }
}

impl<'de> Deserialize<'de> for Storage {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where D: Deserializer<'de> {
        let data = ArrayD::<f32>::deserialize(deserializer)?;
        Ok(Storage::Cpu(data))
    }
}
