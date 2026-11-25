//! Seeded, reproducible weight initialization.
//!
//! # Why `ChaCha8Rng` (and not `StdRng`)
//!
//! The project needs "same seed + same data -> same weights (sha256)" across
//! machines, builds and dependency upgrades. `rand` 0.8's `StdRng` is
//! documented as *not* value-stable between versions (the algorithm behind it
//! may change). `rand_chacha::ChaCha8Rng` implements a fixed, specified stream
//! cipher, so its output for a given 32-byte seed is stable, on native and on
//! `wasm32` alike (no platform-dependent code, no OS entropy involved).
//! ChaCha8 is used (not 12/20) because initialization needs speed, not
//! cryptographic strength.
//!
//! To keep the result independent of library details that are *not* part of
//! that guarantee, this module also avoids:
//!
//! - `SeedableRng::seed_from_u64` (its seed expansion changed between
//!   `rand_core` releases): the 32-byte seed is derived here with SplitMix64.
//! - `rand::distributions::Uniform` (value-stability only per minor version):
//!   floats are built directly from `next_u32()` (24 random bits -> `[-1, 1)`).
//!
//! # Seed derivation
//!
//! A network seed is a `u64`. Each layer gets its own independent stream,
//! [`layer_rng`]`(seed, layer_index)`, so a layer's initial weights depend
//! only on the seed, its index and its own shape (changing the size of layer 3
//! does not alter layer 0..2). Within a layer, tensors are drawn in a fixed
//! field order (documented on each `new_seeded` constructor).
//!
//! The unseeded constructors (`Linear::new`, ...) are unchanged and still use
//! the thread RNG.

use rand::{RngCore, SeedableRng};
use rand_chacha::ChaCha8Rng;

/// The RNG used for every seeded initialization.
pub type InitRng = ChaCha8Rng;

/// SplitMix64 step: advances `state` and returns a well-mixed 64-bit value.
fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn rng_from_state(mut state: u64) -> InitRng {
    let mut bytes = [0u8; 32];
    for chunk in bytes.chunks_exact_mut(8) {
        chunk.copy_from_slice(&splitmix64(&mut state).to_le_bytes());
    }
    InitRng::from_seed(bytes)
}

/// Creates the RNG for a plain `u64` seed.
pub fn rng_from_seed(seed: u64) -> InitRng {
    rng_from_state(seed)
}

/// Creates the independent RNG stream of the layer at `layer_index`
/// for the network seed `seed`.
pub fn layer_rng(seed: u64, layer_index: u64) -> InitRng {
    // Mix the seed first so (seed, index) pairs do not collide trivially
    // (e.g. (1, 0) vs (0, 1)).
    let mut s = seed;
    let mixed = splitmix64(&mut s) ^ layer_index.wrapping_mul(0xD6E8_FEB8_6659_FD93);
    rng_from_state(mixed)
}

/// Draws one `f32` uniformly from `[-1, 1)` using 24 bits of `next_u32()`.
pub fn next_symmetric_f32(rng: &mut InitRng) -> f32 {
    let bits = rng.next_u32() >> 8; // 24 bits
    (bits as f32) / ((1u32 << 23) as f32) - 1.0
}
