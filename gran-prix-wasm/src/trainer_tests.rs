//! Behavioral tests for [`Trainer`]: convergence of the per-sample
//! forward+backward batch loops (E0.1) and training/eval mode (E0.2).
//!
//! Data is generated with a simple LCG so every run is deterministic.
//! Only success paths are exercised: on native targets `JsValue` cannot be
//! constructed, so an error path would panic instead of returning `Err`.

use super::*;

/// Deterministic LCG (same constants as the Node evidence scripts).
struct Lcg(u64);

impl Lcg {
    /// Uniform in `[-1, 1)`.
    fn next(&mut self) -> f32 {
        self.0 = (self.0.wrapping_mul(1_103_515_245).wrapping_add(12_345)) % 2_147_483_648;
        (self.0 as f32 / 2_147_483_648.0) * 2.0 - 1.0
    }
}

fn def_json(input_dim: usize, layers: Vec<LayerDef>) -> String {
    NetworkDef::new(input_dim, layers).to_json().unwrap()
}

fn linear(i: usize, o: usize) -> LayerDef {
    LayerDef::Linear { in_features: i, out_features: o }
}

fn act(function: ActivationType) -> LayerDef {
    LayerDef::Activation { function }
}

fn mean(s: &[f32]) -> f32 {
    s.iter().sum::<f32>() / s.len() as f32
}

// ── E0.1: convergence (batch loop must not leak node gradients) ───────────

/// Binary task `y = (x0 > x1)`. Before the fix this learned the inverse
/// (3-13% accuracy); correct training reaches ~100%.
/// Returns `(accuracy on fresh data, mean loss first 20 steps, last 20 steps)`.
fn binary_run(trainer: &Trainer, lr: f32) -> (f32, f32, f32) {
    let mut rng = Lcg(12345);
    let (steps, batch) = (400, 64);
    let mut losses = Vec::new();
    for _ in 0..steps {
        let mut x = Vec::with_capacity(batch * 2);
        let mut y = Vec::with_capacity(batch);
        for _ in 0..batch {
            let (a, b) = (rng.next(), rng.next());
            x.extend([a, b]);
            y.push(if a > b { 1.0 } else { 0.0 });
        }
        losses.push(trainer.train_batch(x, y, lr).unwrap());
    }
    // Fresh data from a different seed.
    let mut rng = Lcg(987_654_321);
    let n = 1000;
    let mut ok = 0;
    for _ in 0..n {
        let (a, b) = (rng.next(), rng.next());
        let p = trainer.predict(vec![a, b]).unwrap();
        if (p > 0.5) == (a > b) {
            ok += 1;
        }
    }
    (ok as f32 / n as f32, mean(&losses[..20]), mean(&losses[losses.len() - 20..]))
}

#[test]
fn binary_train_batch_converges_on_separable_data() {
    let trainer = Trainer::new(2, vec![8]).unwrap();
    let (acc, first, last) = binary_run(&trainer, 0.05);
    assert!(acc >= 0.95, "tanh MLP accuracy {acc}");
    assert!(last < first, "loss did not fall: first20={first} last20={last}");
}

#[test]
fn binary_train_batch_converges_with_relu_network_def() {
    let json = def_json(
        2,
        vec![linear(2, 16), act(ActivationType::ReLU), linear(16, 1)],
    );
    let trainer = Trainer::from_network_def(&json).unwrap();
    let (acc, first, last) = binary_run(&trainer, 0.01);
    assert!(acc >= 0.95, "relu MLP accuracy {acc}");
    assert!(last < first, "loss did not fall: first20={first} last20={last}");
}

/// Samples a point from one of 3 well separated clusters.
fn cluster_sample(rng: &mut Lcg) -> ([f32; 2], u32) {
    const CENTERS: [[f32; 2]; 3] = [[-0.6, -0.6], [0.6, -0.6], [0.0, 0.7]];
    // `next()` is in [-1, 1); map to a class in {0, 1, 2}.
    let class = (((rng.next() + 1.0) * 1.5) as usize).min(2);
    let c = CENTERS[class];
    ([c[0] + 0.25 * rng.next(), c[1] + 0.25 * rng.next()], class as u32)
}

#[test]
fn multi_class_train_batch_converges_on_three_clusters() {
    let json = def_json(
        2,
        vec![linear(2, 16), act(ActivationType::ReLU), linear(16, 3)],
    );
    let trainer = Trainer::from_network_def(&json).unwrap();
    assert_eq!(trainer.loss_kind(), LossKind::CategoricalCrossEntropy);

    let mut rng = Lcg(2024);
    let (steps, batch) = (300, 32);
    let mut losses = Vec::new();
    for _ in 0..steps {
        let mut x = Vec::with_capacity(batch * 2);
        let mut y = Vec::with_capacity(batch);
        for _ in 0..batch {
            let (p, c) = cluster_sample(&mut rng);
            x.extend(p);
            y.push(c);
        }
        losses.push(trainer.train_batch_multi_class(x, y, 0.05).unwrap());
    }

    let mut rng = Lcg(777_777);
    let n = 1000;
    let mut ok = 0;
    for _ in 0..n {
        let (p, c) = cluster_sample(&mut rng);
        if trainer.predict_class(p.to_vec()).unwrap() == c as usize {
            ok += 1;
        }
    }
    let acc = ok as f32 / n as f32;
    let (first, last) = (mean(&losses[..20]), mean(&losses[losses.len() - 20..]));
    assert!(acc >= 0.95, "multi-class accuracy {acc}");
    assert!(last < first, "loss did not fall: first20={first} last20={last}");
}

/// The scenario of the original bug report: a batch of 2 with targets [1, 0]
/// must move the two outputs apart, each toward its own target.
#[test]
fn batch_of_two_moves_outputs_toward_their_targets() {
    let trainer = Trainer::new(2, vec![4]).unwrap();
    let x = vec![1.0, 0.0, 0.0, 1.0];
    for _ in 0..300 {
        trainer.train_batch(x.clone(), vec![1.0, 0.0], 0.01).unwrap();
    }
    let p = trainer.predict_batch(x, 2).unwrap();
    assert!(p[0] > 0.95 && p[1] < 0.05, "outputs {:?}", p);
}

// ── E0.2: training mode ───────────────────────────────────────────────────

/// Deterministic, non-degenerate weights (the dropout layer has no params, so
/// the same flat vector fits the network with and without dropout).
fn deterministic_weights(trainer: &Trainer) {
    let mut rng = Lcg(31337);
    let n = trainer.get_weights().unwrap().len();
    let w: Vec<f32> = (0..n).map(|_| rng.next() * 0.8).collect();
    trainer.import_weights(&w).unwrap();
}

/// 4 -> 32 -> tanh -> [dropout] -> `out` logits.
fn dropout_net(rate: Option<f32>, out: usize) -> String {
    let mut layers = vec![linear(4, 32), act(ActivationType::Tanh)];
    if let Some(rate) = rate {
        layers.push(LayerDef::Dropout { rate });
    }
    layers.push(linear(32, out));
    def_json(4, layers)
}

/// 16 deterministic binary samples with alternating labels.
fn dropout_batch() -> (Vec<f32>, Vec<f32>) {
    let mut rng = Lcg(5);
    let x: Vec<f32> = (0..16 * 4).map(|_| rng.next()).collect();
    let y: Vec<f32> = (0..16).map(|i| (i % 2) as f32).collect();
    (x, y)
}

/// Mean BCE of the trainer's eval-mode predictions (what a user would
/// compute from `predictBatch`).
fn eval_bce(trainer: &Trainer, x: &[f32], y: &[f32]) -> f32 {
    let p = trainer.predict_batch(x.to_vec(), y.len()).unwrap();
    let mut s = 0.0;
    for (p, t) in p.iter().zip(y) {
        s -= t * p.ln() + (1.0 - t) * (1.0 - p).ln();
    }
    s / y.len() as f32
}

#[test]
fn predictions_are_deterministic_with_dropout_before_and_after_training() {
    let trainer = Trainer::from_network_def(&dropout_net(Some(0.5), 1)).unwrap();
    deterministic_weights(&trainer);
    let (x, y) = dropout_batch();
    let probe = x[..4].to_vec();

    let check = |label: &str| {
        let a = trainer.predict(probe.clone()).unwrap();
        let b = trainer.predict(probe.clone()).unwrap();
        assert_eq!(a.to_bits(), b.to_bits(), "{label}: predict not deterministic");
        let pa = trainer.predict_probs(probe.clone()).unwrap();
        let pb = trainer.predict_probs(probe.clone()).unwrap();
        assert_eq!(pa, pb, "{label}: predict_probs not deterministic");
        let ba = trainer.predict_batch(x.clone(), 16).unwrap();
        let bb = trainer.predict_batch(x.clone(), 16).unwrap();
        assert_eq!(ba, bb, "{label}: predict_batch not deterministic");
        assert!(!trainer.graph.borrow().is_training(), "{label}: left in training mode");
    };

    check("before training");
    for _ in 0..10 {
        trainer.train_batch(x.clone(), y.clone(), 0.01).unwrap();
        // Interleaved predictions must never consume or depend on masks.
        trainer.predict(probe.clone()).unwrap();
    }
    check("after training");
}

#[test]
fn eval_mode_dropout_is_identity() {
    // With identical weights, a net with Dropout(0.5) must predict exactly
    // like the same net without the layer.
    let with = Trainer::from_network_def(&dropout_net(Some(0.5), 1)).unwrap();
    let without = Trainer::from_network_def(&dropout_net(None, 1)).unwrap();
    deterministic_weights(&with);
    deterministic_weights(&without);
    let (x, _) = dropout_batch();
    assert_eq!(
        with.predict_batch(x.clone(), 16).unwrap(),
        without.predict_batch(x, 16).unwrap()
    );
}

/// Criterion for "training actually applies dropout": with `lr = 0` the
/// weights cannot move, so the loss returned by `train_batch` and the loss
/// computed from eval-mode predictions refer to the SAME function, differing
/// only in the mode. Control: without a Dropout layer they agree; with
/// Dropout(0.5) they must differ, and each step must draw a fresh mask.
#[test]
fn train_batch_applies_dropout_unlike_eval() {
    let (x, y) = dropout_batch();

    let plain = Trainer::from_network_def(&dropout_net(None, 1)).unwrap();
    deterministic_weights(&plain);
    let drop = Trainer::from_network_def(&dropout_net(Some(0.5), 1)).unwrap();
    deterministic_weights(&drop);

    // Control: no dropout, train loss == eval loss.
    let plain_train = plain.train_batch(x.clone(), y.clone(), 0.0).unwrap();
    let plain_eval = eval_bce(&plain, &x, &y);
    assert!(
        (plain_train - plain_eval).abs() < 1e-4,
        "control: train {plain_train} vs eval {plain_eval}"
    );

    // lr = 0 must really leave the weights untouched.
    let before = drop.get_weights().unwrap();
    let eval = eval_bce(&drop, &x, &y);
    let train: Vec<f32> = (0..4)
        .map(|_| drop.train_batch(x.clone(), y.clone(), 0.0).unwrap())
        .collect();
    assert_eq!(before, drop.get_weights().unwrap(), "lr=0 moved the weights");

    let max_gap = train.iter().map(|l| (l - eval).abs()).fold(0.0, f32::max);
    assert!(max_gap > 1e-3, "train losses {train:?} indistinguishable from eval {eval}");
    let (lo, hi) = train
        .iter()
        .fold((f32::MAX, f32::MIN), |(lo, hi), &l| (lo.min(l), hi.max(l)));
    assert!(hi - lo > 1e-4, "dropout mask did not change between steps: {train:?}");
    assert!(!drop.graph.borrow().is_training(), "train_batch left training mode on");
}

#[test]
fn train_batch_multi_class_applies_dropout_unlike_eval() {
    let mut rng = Lcg(11);
    let x: Vec<f32> = (0..16 * 4).map(|_| rng.next()).collect();
    let y: Vec<u32> = (0..16).map(|i| (i % 3) as u32).collect();

    let plain = Trainer::from_network_def(&dropout_net(None, 3)).unwrap();
    deterministic_weights(&plain);
    let drop = Trainer::from_network_def(&dropout_net(Some(0.5), 3)).unwrap();
    deterministic_weights(&drop);

    // Eval-mode categorical cross-entropy from predict_probs_batch.
    let eval_cce = |t: &Trainer| {
        let p = t.predict_probs_batch(x.clone(), 16).unwrap();
        let s: f32 = y.iter().enumerate().map(|(i, &c)| -p[i * 3 + c as usize].ln()).sum();
        s / 16.0
    };

    let plain_train = plain.train_batch_multi_class(x.clone(), y.clone(), 0.0).unwrap();
    let plain_eval = eval_cce(&plain);
    assert!(
        (plain_train - plain_eval).abs() < 1e-4,
        "control: train {plain_train} vs eval {plain_eval}"
    );

    let eval = eval_cce(&drop);
    let train = drop.train_batch_multi_class(x.clone(), y.clone(), 0.0).unwrap();
    assert!((train - eval).abs() > 1e-3, "train {train} indistinguishable from eval {eval}");
    assert!(!drop.graph.borrow().is_training(), "multi-class train left training mode on");
}

#[test]
fn dropout_trainer_still_converges() {
    // Dropout active during training must not break learning (the dropout
    // gradient mask interacts with the per-call node gradients in backward).
    let json = def_json(
        2,
        vec![
            linear(2, 16),
            act(ActivationType::ReLU),
            LayerDef::Dropout { rate: 0.2 },
            linear(16, 1),
        ],
    );
    let trainer = Trainer::from_network_def(&json).unwrap();
    let (acc, first, last) = binary_run(&trainer, 0.01);
    assert!(acc >= 0.95, "dropout MLP accuracy {acc}");
    assert!(last < first, "loss did not fall: first20={first} last20={last}");
}

// ── E0 inherited: eval mode is restored when the training loop errors ─────
//
// Native tests cannot reach the `JsValue` error path (`JsValue` panics off
// wasm32), so the loops are typed `GPError` inner functions and the
// `#[wasm_bindgen]` methods only map the error. These tests drive the real
// loops to a genuine `GPError` through `with_training_mode`.

#[test]
fn with_training_mode_restores_eval_on_ok_and_err() {
    let trainer = Trainer::from_network_def(&dropout_net(Some(0.5), 1)).unwrap();
    let mut graph = trainer.graph.borrow_mut();
    assert!(!graph.is_training(), "trainer must start in eval mode");

    let ok: Result<u8, GPError> = with_training_mode(&mut graph, |g| {
        assert!(g.is_training(), "closure must run in training mode");
        Ok(7)
    });
    assert_eq!(ok.unwrap(), 7);
    assert!(!graph.is_training(), "eval mode not restored after Ok");

    let err: Result<u8, GPError> = with_training_mode(&mut graph, |g| {
        assert!(g.is_training(), "closure must run in training mode");
        Err(GPError::InferenceError("boom".into()))
    });
    assert!(err.is_err());
    assert!(!graph.is_training(), "eval mode not restored after Err");
}

/// An out-of-bounds node in the execution order makes
/// `execute_with_order` fail inside the per-sample loop.
const BAD_ORDER: [NodeId; 1] = [NodeId(usize::MAX)];
#[test]
fn binary_loop_error_restores_eval_mode_and_keeps_predictions_deterministic() {
    let trainer = Trainer::from_network_def(&dropout_net(Some(0.5), 1)).unwrap();
    deterministic_weights(&trainer);
    let (x, y) = dropout_batch();
    let probe = x[..4].to_vec();
    let before = trainer.predict(probe.clone()).unwrap();

    {
        let mut graph = trainer.graph.borrow_mut();
        let res = with_training_mode(&mut graph, |g| trainer.binary_batch_loop(g, &BAD_ORDER, &x, &y));
        assert!(res.is_err(), "out-of-bounds execution order must fail inside the loop");
        assert!(!graph.is_training(), "loop error left the graph in training mode");
    }

    let a = trainer.predict(probe.clone()).unwrap();
    let b = trainer.predict(probe).unwrap();
    assert_eq!(a.to_bits(), b.to_bits(), "predict not deterministic after a failed step");
    assert_eq!(a.to_bits(), before.to_bits(), "failed step changed predictions");
}

#[test]
fn multi_class_loop_error_restores_eval_mode_and_keeps_predictions_deterministic() {
    let trainer = Trainer::from_network_def(&dropout_net(Some(0.5), 3)).unwrap();
    deterministic_weights(&trainer);
    let mut rng = Lcg(5);
    let x: Vec<f32> = (0..16 * 4).map(|_| rng.next()).collect();
    let y: Vec<u32> = (0..16).map(|i| (i % 3) as u32).collect();
    let probe = x[..4].to_vec();
    let before = trainer.predict_probs(probe.clone()).unwrap();

    {
        let mut graph = trainer.graph.borrow_mut();
        let res = with_training_mode(&mut graph, |g| trainer.multi_class_batch_loop(g, &BAD_ORDER, &x, &y));
        assert!(res.is_err(), "out-of-bounds execution order must fail inside the loop");
        assert!(!graph.is_training(), "loop error left the graph in training mode");
    }

    let a = trainer.predict_probs(probe.clone()).unwrap();
    let b = trainer.predict_probs(probe).unwrap();
    assert_eq!(a, b, "predict_probs not deterministic after a failed step");
    assert_eq!(a, before, "failed step changed predictions");
}
