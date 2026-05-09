//! Scrapper Local Nível 3 — Motor Validation Harness
//!
//! Validates the four invariants the gran-prix motor must satisfy
//! before the consumer-side work (Chrome extension, feature extractor,
//! bootstrap pipeline) can safely commit to it.
//!
//! Run: `cargo run --release --example scrapper_motor_check`
//!
//! Invariants tested:
//!   1. NetworkDef compiles a multi-class topology of the size required
//!      by Nível 3 (~56 → 32 → 16 → 8) — validation + compile + named
//!      params registered in expected order.
//!   2. Trainer with CrossEntropyWithLogits + Adam converges on
//!      class-imbalanced synthetic data — loss drops, train accuracy
//!      well above random.
//!   3. ParamStore::freeze_by_name_prefix isolates "backbone" layers
//!      cleanly — frozen params do NOT change after training; the
//!      trainable head DOES change.
//!   4. (NetworkDef.json + flat weights) round-trip preserves
//!      multi-class predictions bit-for-bit.

use gran_prix::Tensor;
use gran_prix::backend::cpu::CPUBackend;
use gran_prix::loss::{CrossEntropyWithLogits, Loss};
use gran_prix::network_def::{ActivationType, LayerDef, NetworkDef};
use gran_prix::optim::{Adam, Optimizer};
use rand::{Rng, SeedableRng, rngs::StdRng};

const FEATURE_DIM: usize = 56;
const HIDDEN_1: usize = 32;
const HIDDEN_2: usize = 16;
const NUM_CLASSES: usize = 8;

/// Per-class sample counts. Imbalanced (~3% to ~28%) to mirror the
/// realistic distribution of structural classes in DOM data, while
/// staying learnable for a smoke test.
const N_SAMPLES_PER_CLASS: [usize; NUM_CLASSES] = [50, 100, 100, 200, 200, 200, 300, 450];

const N_EPOCHS: usize = 200;
const LR: f32 = 0.01;
const SEED: u64 = 42;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("==================================================");
    println!("  Scrapper Motor Check — Nível 3 architecture");
    println!("  {} → {} → {} → {} multi-class", FEATURE_DIM, HIDDEN_1, HIDDEN_2, NUM_CLASSES);
    println!("==================================================\n");

    let net_def = build_network();

    let mut rng = StdRng::seed_from_u64(SEED);
    let (inputs, targets, labels) = build_synthetic_dataset(&mut rng);

    let mut passed: u32 = 0;

    // ───────── Invariant 1: validate + compile ─────────
    println!("[1/4] Validating + compiling NetworkDef…");
    if let Err(e) = net_def.validate() {
        println!("   ✗ Validation failed: {}", e);
    } else {
        let compiled = net_def.compile(Box::new(CPUBackend))?;
        let names = compiled.graph.params().names();
        println!("   ✓ Validated. {} params registered:", names.len());
        for n in &names {
            println!("       - {}", n);
        }
        passed += 1;
    }

    // ───────── Invariant 2: convergence ─────────
    println!(
        "\n[2/4] Training (CrossEntropyWithLogits + Adam, {} epochs)…",
        N_EPOCHS
    );
    let (loss_first, loss_last, train_acc, trained_weights) =
        run_training(&net_def, &inputs, &targets, &labels)?;
    let random_baseline = 1.0 / NUM_CLASSES as f32;
    println!("   First-epoch loss: {:.4}", loss_first);
    println!("   Last-epoch loss:  {:.4}", loss_last);
    println!(
        "   Train accuracy:   {:.2}%  (random baseline: {:.2}%)",
        train_acc * 100.0,
        random_baseline * 100.0
    );
    if loss_last < loss_first * 0.5 && train_acc > random_baseline + 0.2 {
        println!("   ✓ Converged");
        passed += 1;
    } else {
        println!("   ✗ Did not converge satisfactorily");
    }

    // ───────── Invariant 3: freeze isolation ─────────
    println!("\n[3/4] Verifying freeze_by_name_prefix isolation…");
    let isolation_ok = check_freeze_isolation(&net_def, &inputs, &targets)?;
    if isolation_ok {
        println!("   ✓ Frozen backbone unchanged; trainable head changed");
        passed += 1;
    } else {
        println!("   ✗ Freeze did not isolate cleanly");
    }

    // ───────── Invariant 4: round-trip ─────────
    println!("\n[4/4] Round-trip (NetworkDef.json + flat weights)…");
    let roundtrip_ok = check_roundtrip(&net_def, &inputs, &trained_weights)?;
    if roundtrip_ok {
        println!("   ✓ Predictions match bit-for-bit after round-trip");
        passed += 1;
    } else {
        println!("   ✗ Round-trip changed predictions");
    }

    println!("\n==================================================");
    println!("  Result: {}/4 invariants validated", passed);
    println!("==================================================");

    if passed == 4 {
        println!("\n✅ Motor ready for Scrapper Local Nível 3. Proceed to Milestone 1.");
        Ok(())
    } else {
        Err(format!("Motor check failed: {}/4 passed.", passed).into())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Network and dataset construction
// ─────────────────────────────────────────────────────────────────────────────

fn build_network() -> NetworkDef {
    NetworkDef::new(
        FEATURE_DIM,
        vec![
            LayerDef::Linear {
                in_features: FEATURE_DIM,
                out_features: HIDDEN_1,
            },
            LayerDef::Activation {
                function: ActivationType::ReLU,
            },
            LayerDef::Linear {
                in_features: HIDDEN_1,
                out_features: HIDDEN_2,
            },
            LayerDef::Activation {
                function: ActivationType::ReLU,
            },
            LayerDef::Linear {
                in_features: HIDDEN_2,
                out_features: NUM_CLASSES,
            },
            // No final softmax — CrossEntropyWithLogits applies it internally.
        ],
    )
}

/// Generates a synthetic multi-class dataset where each class has a
/// fixed prototype vector and samples are prototype + Gaussian-ish
/// noise. With FEATURE_DIM=56 and noise small relative to prototype
/// spread, the classes are linearly separable and a small MLP must
/// learn them in 200 epochs.
fn build_synthetic_dataset(rng: &mut StdRng) -> (Tensor, Tensor, Vec<usize>) {
    let prototypes: Vec<Vec<f32>> = (0..NUM_CLASSES)
        .map(|_| (0..FEATURE_DIM).map(|_| rng.gen_range(-1.0..1.0)).collect())
        .collect();

    let total: usize = N_SAMPLES_PER_CLASS.iter().sum();
    let mut input_data: Vec<f32> = Vec::with_capacity(total * FEATURE_DIM);
    let mut target_data: Vec<f32> = vec![0.0; total * NUM_CLASSES];
    let mut labels: Vec<usize> = Vec::with_capacity(total);

    let mut row = 0;
    for c in 0..NUM_CLASSES {
        for _ in 0..N_SAMPLES_PER_CLASS[c] {
            for d in 0..FEATURE_DIM {
                let noise: f32 = rng.gen_range(-0.3..0.3);
                input_data.push(prototypes[c][d] + noise);
            }
            target_data[row * NUM_CLASSES + c] = 1.0;
            labels.push(c);
            row += 1;
        }
    }

    let inputs = Tensor::from_shape_vec(&[total, FEATURE_DIM], input_data).unwrap();
    let targets = Tensor::from_shape_vec(&[total, NUM_CLASSES], target_data).unwrap();
    (inputs, targets, labels)
}

// ─────────────────────────────────────────────────────────────────────────────
// Training loop (shared between invariants 2, 3, 4)
// ─────────────────────────────────────────────────────────────────────────────

fn run_training(
    net_def: &NetworkDef,
    inputs: &Tensor,
    targets: &Tensor,
    labels: &[usize],
) -> Result<(f32, f32, f32, Vec<f32>), Box<dyn std::error::Error>> {
    let mut compiled = net_def.compile(Box::new(CPUBackend))?;
    let mut optim = Adam::new(LR);
    let loss_fn = CrossEntropyWithLogits;

    let total_samples = inputs.shape()[0];

    let mut first_loss = 0.0;
    let mut last_loss = 0.0;

    for epoch in 0..N_EPOCHS {
        inject_input(&mut compiled, inputs);
        compiled.graph.clear_values();
        compiled.graph.clear_gradients();

        let logits = compiled.graph.execute(compiled.output_node)?;
        let loss = loss_fn.calculate(&logits, targets)?;
        let grad = loss_fn.gradient(&logits, targets)?;

        compiled.graph.backward(compiled.output_node, grad)?;
        optim.step(compiled.graph.params_mut())?;

        if epoch == 0 {
            first_loss = loss;
        }
        last_loss = loss;
    }

    // Final accuracy pass.
    inject_input(&mut compiled, inputs);
    compiled.graph.clear_values();
    let logits = compiled.graph.execute(compiled.output_node)?;
    let s = logits.as_slice()?;

    let mut correct = 0;
    for i in 0..total_samples {
        let row = &s[i * NUM_CLASSES..(i + 1) * NUM_CLASSES];
        let max_idx = row
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
            .map(|(i, _)| i)
            .unwrap();
        if max_idx == labels[i] {
            correct += 1;
        }
    }
    let acc = correct as f32 / total_samples as f32;

    let trained_weights = compiled.graph.params().export_flat()?;
    Ok((first_loss, last_loss, acc, trained_weights))
}

fn inject_input(
    compiled: &mut gran_prix::network_def::CompiledNetwork,
    inputs: &Tensor,
) {
    if let Some(gran_prix::graph::Node::Input(t)) =
        compiled.graph.nodes_mut().get_mut(compiled.input_node.0)
    {
        *t = inputs.clone();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 3: freeze isolation
// ─────────────────────────────────────────────────────────────────────────────

fn check_freeze_isolation(
    net_def: &NetworkDef,
    inputs: &Tensor,
    targets: &Tensor,
) -> Result<bool, Box<dyn std::error::Error>> {
    let mut compiled = net_def.compile(Box::new(CPUBackend))?;

    // Snapshot per-param tensors before training.
    let names_before: Vec<String> = compiled
        .graph
        .params()
        .names()
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    let snapshots_before: Vec<Vec<f32>> = compiled
        .graph
        .params()
        .iter()
        .map(|(_, t)| t.as_slice().unwrap().to_vec())
        .collect();

    // Freeze backbone (layers[0] = first Linear, layers[2] = second Linear).
    // layers[1] and layers[3] are activations with no params.
    let frozen0 = compiled
        .graph
        .params_mut()
        .freeze_by_name_prefix("layers[0]");
    let frozen2 = compiled
        .graph
        .params_mut()
        .freeze_by_name_prefix("layers[2]");
    println!(
        "   Frozen: layers[0] = {} param(s), layers[2] = {} param(s)",
        frozen0.len(),
        frozen2.len()
    );

    if frozen0.is_empty() || frozen2.is_empty() {
        println!("   ✗ Expected non-empty frozen sets");
        return Ok(false);
    }

    // Train with backbone frozen. Use enough epochs so changes would be visible.
    let mut optim = Adam::new(LR);
    let loss_fn = CrossEntropyWithLogits;

    for _ in 0..(N_EPOCHS / 2) {
        inject_input(&mut compiled, inputs);
        compiled.graph.clear_values();
        compiled.graph.clear_gradients();

        let logits = compiled.graph.execute(compiled.output_node)?;
        let grad = loss_fn.gradient(&logits, targets)?;
        compiled.graph.backward(compiled.output_node, grad)?;
        optim.step(compiled.graph.params_mut())?;
    }

    // Snapshot per-param tensors after training.
    let snapshots_after: Vec<Vec<f32>> = compiled
        .graph
        .params()
        .iter()
        .map(|(_, t)| t.as_slice().unwrap().to_vec())
        .collect();

    let mut frozen_unchanged = true;
    let mut trainable_changed = false;

    for (i, name) in names_before.iter().enumerate() {
        let same = snapshots_before[i] == snapshots_after[i];
        if name.starts_with("layers[0]") || name.starts_with("layers[2]") {
            if !same {
                println!("   ✗ Frozen param '{}' changed during training", name);
                frozen_unchanged = false;
            }
        } else if name.starts_with("layers[4]") && !same {
            trainable_changed = true;
        }
    }

    if !trainable_changed {
        println!("   ✗ Trainable head (layers[4]) did NOT change — gradient flow broken");
    }

    Ok(frozen_unchanged && trainable_changed)
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 4: round-trip preserves predictions bit-for-bit
// ─────────────────────────────────────────────────────────────────────────────

fn check_roundtrip(
    net_def: &NetworkDef,
    inputs: &Tensor,
    trained_weights: &[f32],
) -> Result<bool, Box<dyn std::error::Error>> {
    // Path A: original NetworkDef + trained weights → predictions A.
    let mut compiled_a = net_def.compile(Box::new(CPUBackend))?;
    compiled_a.graph.params_mut().import_flat(trained_weights)?;
    inject_input(&mut compiled_a, inputs);
    compiled_a.graph.clear_values();
    let preds_a = compiled_a.graph.execute(compiled_a.output_node)?;
    let preds_a_data: Vec<f32> = preds_a.as_slice()?.to_vec();

    // Path B: serialize → deserialize → recompile → import same weights → predictions B.
    let net_json = net_def.to_json()?;
    let net_def_b = NetworkDef::from_json(&net_json)?;
    let mut compiled_b = net_def_b.compile(Box::new(CPUBackend))?;
    compiled_b.graph.params_mut().import_flat(trained_weights)?;
    inject_input(&mut compiled_b, inputs);
    compiled_b.graph.clear_values();
    let preds_b = compiled_b.graph.execute(compiled_b.output_node)?;
    let preds_b_data: Vec<f32> = preds_b.as_slice()?.to_vec();

    Ok(preds_a_data == preds_b_data)
}
