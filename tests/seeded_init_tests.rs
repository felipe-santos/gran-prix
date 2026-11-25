//! E0.3 — seeded weight initialization: reproducibility, sensitivity to the
//! seed, coverage of every `LayerDef` variant, independence from the global
//! RNG and a golden pin of the algorithm.

use gran_prix::backend::cpu::CPUBackend;
use gran_prix::network_def::{ActivationType, LayerDef, NetworkDef};

fn weights(net: &NetworkDef, seed: u64) -> Vec<f32> {
    let compiled = net.compile_seeded(Box::new(CPUBackend), seed).unwrap();
    compiled.graph.params().export_flat().unwrap()
}

/// FNV-1a 64 over the little-endian bit patterns (stable, dependency-free).
fn fingerprint(w: &[f32]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for v in w {
        for b in v.to_bits().to_le_bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

fn bits(w: &[f32]) -> Vec<u32> {
    w.iter().map(|v| v.to_bits()).collect()
}

fn mlp() -> NetworkDef {
    NetworkDef::mlp(4, &[8, 6], 1, ActivationType::Tanh, None)
}

fn all_layers() -> NetworkDef {
    NetworkDef::new(
        3,
        vec![
            LayerDef::Linear { in_features: 3, out_features: 5 },
            LayerDef::Activation { function: ActivationType::ReLU },
            LayerDef::BatchNorm { num_features: 5 },
            LayerDef::Dropout { rate: 0.2 },
            LayerDef::Rnn { input_size: 5, hidden_size: 4 },
            LayerDef::Gru { input_size: 4, hidden_size: 3 },
            LayerDef::Linear { in_features: 3, out_features: 1 },
        ],
    )
}

#[test]
fn same_seed_gives_identical_weights() {
    let a = weights(&mlp(), 42);
    let b = weights(&mlp(), 42);
    assert!(!a.is_empty());
    assert_eq!(bits(&a), bits(&b));
    assert_eq!(fingerprint(&a), fingerprint(&b));
}

#[test]
fn different_seeds_give_different_weights() {
    let a = weights(&mlp(), 42);
    let b = weights(&mlp(), 43);
    assert_eq!(a.len(), b.len());
    assert_ne!(bits(&a), bits(&b));
    assert_ne!(fingerprint(&a), fingerprint(&b));
    // Sequential seeds (0, 1) must also differ.
    assert_ne!(bits(&weights(&mlp(), 0)), bits(&weights(&mlp(), 1)));
}

#[test]
fn seeded_compile_supports_every_layer_variant() {
    let net = all_layers();
    let a = weights(&net, 7);
    let b = weights(&net, 7);
    let c = weights(&net, 8);
    assert_eq!(bits(&a), bits(&b));
    assert_ne!(bits(&a), bits(&c));
    assert!(a.iter().all(|v| v.is_finite()));

    // Each layer kind is covered on its own as well.
    let singles = vec![
        NetworkDef::new(3, vec![LayerDef::Linear { in_features: 3, out_features: 2 }]),
        NetworkDef::new(3, vec![
            LayerDef::Linear { in_features: 3, out_features: 2 },
            LayerDef::Activation { function: ActivationType::Sigmoid },
        ]),
        NetworkDef::new(3, vec![LayerDef::Rnn { input_size: 3, hidden_size: 2 }]),
        NetworkDef::new(3, vec![LayerDef::Gru { input_size: 3, hidden_size: 2 }]),
        NetworkDef::new(3, vec![
            LayerDef::Linear { in_features: 3, out_features: 2 },
            LayerDef::Dropout { rate: 0.5 },
        ]),
        NetworkDef::new(3, vec![
            LayerDef::Linear { in_features: 3, out_features: 2 },
            LayerDef::BatchNorm { num_features: 2 },
        ]),
    ];
    for net in &singles {
        assert_eq!(bits(&weights(net, 5)), bits(&weights(net, 5)));
    }
    // Recurrent layers must actually be random (not silently all zeros).
    let rnn = weights(&singles[2], 5);
    assert!(rnn.iter().any(|v| *v != 0.0));
}

#[test]
fn seeded_weights_ignore_the_global_rng() {
    use gran_prix::Tensor;
    let first = weights(&all_layers(), 99);
    // Consume the thread RNG heavily and use the unseeded constructors in between.
    for _ in 0..5 {
        let _ = Tensor::new_random(&[16, 16]);
        let _ = mlp().compile(Box::new(CPUBackend)).unwrap();
    }
    let second = weights(&all_layers(), 99);
    // A different thread has a different thread RNG state: still identical.
    let third = std::thread::spawn(|| weights(&all_layers(), 99)).join().unwrap();
    assert_eq!(bits(&first), bits(&second));
    assert_eq!(bits(&first), bits(&third));
}

#[test]
fn unseeded_compile_is_still_random() {
    let a = mlp().compile(Box::new(CPUBackend)).unwrap().graph.params().export_flat().unwrap();
    let b = mlp().compile(Box::new(CPUBackend)).unwrap().graph.params().export_flat().unwrap();
    assert_ne!(bits(&a), bits(&b));
}

#[test]
fn xavier_bounds_and_zero_biases_hold() {
    // Linear(4 -> 8): weights in [-limit, limit], limit = sqrt(6/12); biases zero.
    let net = NetworkDef::new(4, vec![LayerDef::Linear { in_features: 4, out_features: 8 }]);
    let w = weights(&net, 1);
    let (weights_part, bias_part) = w.split_at(32);
    let limit = (6.0f32 / 12.0).sqrt();
    assert!(weights_part.iter().all(|v| v.abs() <= limit));
    assert!(weights_part.iter().any(|v| *v != 0.0));
    assert!(bias_part.iter().all(|v| *v == 0.0));
}

#[test]
fn layer_streams_are_independent_of_later_layers() {
    // Changing the size of the LAST layer must not change layer 0's weights.
    let a = NetworkDef::new(2, vec![
        LayerDef::Linear { in_features: 2, out_features: 3 },
        LayerDef::Linear { in_features: 3, out_features: 1 },
    ]);
    let b = NetworkDef::new(2, vec![
        LayerDef::Linear { in_features: 2, out_features: 3 },
        LayerDef::Linear { in_features: 3, out_features: 5 },
    ]);
    let (wa, wb) = (weights(&a, 11), weights(&b, 11));
    let first_layer_params = 2 * 3 + 3;
    assert_eq!(bits(&wa[..first_layer_params]), bits(&wb[..first_layer_params]));
}

/// Golden values: any change to the init algorithm (RNG, seed expansion,
/// float conversion, Xavier scaling, draw order) breaks this test on purpose.
/// If the change is intentional, update the constants AND treat it as a
/// breaking change for anyone relying on seeded weights.
#[test]
fn golden_weights_for_fixed_seed_and_architecture() {
    let w = weights(&mlp(), 42);
    // 4*8+8 + 8*6+6 + 6*1+1 = 101 parameters.
    assert_eq!(w.len(), 101);
    let first: Vec<u32> = bits(&w[..4]);
    assert_eq!(first, GOLDEN_FIRST_BITS, "first weights changed: {:?}", first);
    assert_eq!(fingerprint(&w), GOLDEN_FINGERPRINT, "fingerprint changed: {:#x}", fingerprint(&w));

    let g = weights(&all_layers(), 42);
    assert_eq!(fingerprint(&g), GOLDEN_FINGERPRINT_ALL, "fingerprint(all) changed: {:#x}", fingerprint(&g));
}

const GOLDEN_FIRST_BITS: [u32; 4] = [1059643638, 1037731928, 1057512623, 1043759682];
const GOLDEN_FINGERPRINT: u64 = 0xdf8e1e23c03ededa;
const GOLDEN_FINGERPRINT_ALL: u64 = 0xcfd3fec250c16478;
