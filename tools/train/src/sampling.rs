//! Seeded shuffling and class-balance resampling.
//!
//! Everything draws from the core's ChaCha8 stream (`gran_prix::init::InitRng`) through
//! `next_u64`, with hand-written bounded sampling and Fisher-Yates, so the order of the
//! samples depends only on the seed and not on the version-specific behavior of `rand`'s
//! `SliceRandom` / `Uniform`.

use crate::config::ClassBalance;
use gran_prix::init::{rng_from_seed, InitRng};
use rand::RngCore;

/// Stream used for sampling: independent of the weight-initialization streams, which are
/// `layer_rng(seed, i)`.
pub fn sampling_rng(seed: u64) -> InitRng {
    rng_from_seed(seed ^ 0xA076_1D64_78BD_642F)
}

/// Uniform integer in `[0, n)` without modulo bias. `n` must be > 0.
pub fn below(rng: &mut InitRng, n: usize) -> usize {
    let n = n.max(1) as u64;
    let zone = (u64::MAX / n) * n;
    loop {
        let v = rng.next_u64();
        if v < zone {
            return (v % n) as usize;
        }
    }
}

/// In-place Fisher-Yates shuffle.
pub fn shuffle<T>(items: &mut [T], rng: &mut InitRng) {
    for i in (1..items.len()).rev() {
        let j = below(rng, i + 1);
        items.swap(i, j);
    }
}

/// Row indices of one epoch, before shuffling, under the class-balance strategy:
///
/// * `none`, `pos_weight`: every row once (`pos_weight` acts on the loss, not on sampling).
/// * `oversample_pos`: positives are drawn again, with replacement, until they reach
///   `target_pos_rate` (default 0.5) of the epoch. Never removes rows.
/// * `undersample_neg`: a fresh random subset of the negatives (without replacement) is kept
///   so positives reach `target_pos_rate`. Never adds rows.
pub fn epoch_indices(y: &[u8], balance: &ClassBalance, rng: &mut InitRng) -> Vec<usize> {
    let pos: Vec<usize> = (0..y.len()).filter(|i| y[*i] == 1).collect();
    let neg: Vec<usize> = (0..y.len()).filter(|i| y[*i] == 0).collect();
    let rate = balance.target_pos_rate.unwrap_or(0.5);
    let mut out: Vec<usize> = Vec::with_capacity(y.len());
    match balance.strategy.as_str() {
        "oversample_pos" if !pos.is_empty() && !neg.is_empty() => {
            // positives p' such that p' / (p' + n) >= rate
            let wanted = ((rate * neg.len() as f64) / (1.0 - rate)).ceil() as usize;
            out.extend_from_slice(&neg);
            out.extend_from_slice(&pos);
            for _ in pos.len()..wanted {
                out.push(pos[below(rng, pos.len())]);
            }
        }
        "undersample_neg" if !pos.is_empty() && !neg.is_empty() => {
            // negatives n' such that p / (p + n') >= rate
            let keep = (((pos.len() as f64) * (1.0 - rate) / rate).ceil() as usize).min(neg.len());
            let mut pool = neg;
            for i in 0..keep {
                let j = i + below(rng, pool.len() - i);
                pool.swap(i, j);
            }
            out.extend_from_slice(&pool[..keep]);
            out.extend_from_slice(&pos);
        }
        _ => out.extend(0..y.len()),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PINNED_SHUFFLE_8_SEED_42: [u32; 8] = [2, 4, 3, 0, 7, 1, 6, 5];

    fn balance(strategy: &str, rate: Option<f64>) -> ClassBalance {
        ClassBalance { strategy: strategy.to_string(), target_pos_rate: rate, pos_weight: None }
    }

    #[test]
    fn shuffle_is_a_permutation_and_deterministic_per_seed() {
        let mut a: Vec<u32> = (0..50).collect();
        let mut b = a.clone();
        let mut c = a.clone();
        shuffle(&mut a, &mut sampling_rng(7));
        shuffle(&mut b, &mut sampling_rng(7));
        shuffle(&mut c, &mut sampling_rng(8));
        assert_eq!(a, b, "same seed -> same order");
        assert_ne!(a, c, "different seed -> different order");
        let mut sorted = a.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..50).collect::<Vec<u32>>());
        assert_ne!(a, (0..50).collect::<Vec<u32>>(), "actually shuffled");
    }

    /// Golden values: pin the stream so a dependency upgrade cannot silently change every
    /// trained model.
    #[test]
    fn shuffle_order_is_pinned() {
        let mut v: Vec<u32> = (0..8).collect();
        shuffle(&mut v, &mut sampling_rng(42));
        assert_eq!(v, PINNED_SHUFFLE_8_SEED_42);
    }

    #[test]
    fn below_is_in_range_and_roughly_uniform() {
        let mut rng = sampling_rng(1);
        let mut counts = [0usize; 5];
        for _ in 0..50_000 {
            counts[below(&mut rng, 5)] += 1;
        }
        for c in counts {
            assert!((c as f64 - 10_000.0).abs() < 600.0, "{counts:?}");
        }
    }

    #[test]
    fn none_and_pos_weight_use_every_row_once() {
        let y = [1, 0, 0, 0, 1, 0];
        for s in ["none", "pos_weight"] {
            let idx = epoch_indices(&y, &balance(s, None), &mut sampling_rng(0));
            assert_eq!(idx, vec![0, 1, 2, 3, 4, 5]);
        }
    }

    #[test]
    fn oversample_reaches_the_target_rate_with_replacement() {
        let mut y = vec![0u8; 90];
        y.extend(vec![1u8; 10]);
        let idx = epoch_indices(&y, &balance("oversample_pos", Some(0.5)), &mut sampling_rng(3));
        let pos = idx.iter().filter(|i| y[**i] == 1).count();
        let neg = idx.len() - pos;
        assert_eq!(neg, 90, "no negative is dropped");
        assert_eq!(pos, 90, "positives are replicated up to 50%");
        assert!(idx.iter().filter(|i| y[**i] == 1).all(|i| *i >= 90));
    }

    #[test]
    fn undersample_keeps_all_positives_and_a_fresh_negative_subset_each_epoch() {
        let mut y = vec![0u8; 90];
        y.extend(vec![1u8; 10]);
        let mut rng = sampling_rng(3);
        let a = epoch_indices(&y, &balance("undersample_neg", Some(0.5)), &mut rng);
        let b = epoch_indices(&y, &balance("undersample_neg", Some(0.5)), &mut rng);
        for idx in [&a, &b] {
            assert_eq!(idx.iter().filter(|i| y[**i] == 1).count(), 10);
            assert_eq!(idx.iter().filter(|i| y[**i] == 0).count(), 10);
            let mut uniq = idx.clone();
            uniq.sort_unstable();
            uniq.dedup();
            assert_eq!(uniq.len(), idx.len(), "negatives are sampled without replacement");
        }
        assert_ne!(a, b, "the subset changes between epochs");
    }

    #[test]
    fn single_class_data_falls_back_to_plain_epochs() {
        let y = [1u8, 1, 1];
        assert_eq!(epoch_indices(&y, &balance("oversample_pos", None), &mut sampling_rng(0)), vec![0, 1, 2]);
        assert_eq!(epoch_indices(&y, &balance("undersample_neg", None), &mut sampling_rng(0)), vec![0, 1, 2]);
    }
}
