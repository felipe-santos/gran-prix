use wasm_bindgen::prelude::*;

pub mod brain;
pub mod population;
pub mod mutation;
pub mod trainer;
#[cfg(all(test, target_arch = "wasm32"))]
pub mod diag;

// Re-export key types for convenience (though wasm_bindgen handles its own exports)
pub use brain::NeuralBrain;
pub use population::Population;
pub use mutation::MutationStrategy;
pub use trainer::Trainer;

#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    pub fn log(s: &str);
}
