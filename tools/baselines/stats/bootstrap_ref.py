"""Reference (Python + NumPy) of the canonical cluster bootstrap of protocol experimento-dom-v0, section 6.5.

The TypeScript twin is packages/stats/src/bootstrap.ts; packages/stats/README.md is the specification.
Both must produce the same resampled indices and the same interval to the last bit
(packages/stats/test/bootstrap-parity.test.ts compares them on the fixture this module writes).

The algorithm, in the order the generator is consumed:

  1. Units (clusters) are identified by (stratum, key). Canonical order: stratified -> by (stratum, key);
     otherwise -> by (key, stratum). Strings compare by code point (Python's default). Repeats are an error.
  2. Pools: one per stratum in that order (one pool with everything when not stratified).
  3. Replicate b = 0..B-1: for each pool in order, ONE call rng.integers(0, n, size=n) on
     rng = numpy.random.default_rng(seed); the i-th value picks the unit at that position of the pool.
  4. The statistic of a replicate is a function of the per-unit counts. Non-finite statistics are dropped;
     the interval is None if fewer than half of B survive.
  5. Interval: numpy.quantile(finite, [lo, hi], method="linear"), lo = round12((1 - level) / 2),
     hi = round12(1 - lo) (round12: 12 decimals), i.e. the 2.5% / 97.5% percentiles for level 0.95.

Run `python bootstrap_ref.py [--out FILE]` to emit the parity fixture (JSON) used by the TS tests.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys

import numpy as np


def round12(x: float) -> float:
    return float(f"{x:.12f}")


def ci_quantiles(level: float) -> tuple[float, float]:
    lo = round12((1 - level) / 2)
    return lo, round12(1 - lo)


def canonical_pools(units: list[tuple[str, str]], stratified: bool) -> list[list[int]]:
    """Steps 1-2: pools of indices into `units`, in canonical order."""
    if stratified:
        order = sorted(range(len(units)), key=lambda i: (units[i][0], units[i][1]))
    else:
        order = sorted(range(len(units)), key=lambda i: (units[i][1], units[i][0]))
    for a, b in zip(order, order[1:]):
        if units[a] == units[b]:
            raise ValueError(f"duplicate bootstrap unit {units[a]!r}")
    if not stratified:
        return [order] if order else []
    pools: list[list[int]] = []
    last = None
    for i in order:
        if last is None or units[i][0] != last:
            pools.append([])
            last = units[i][0]
        pools[-1].append(i)
    return pools


def draw_indices(pools: list[list[int]], rng: np.random.Generator) -> list[list[int]]:
    """Step 3, one replicate: the picked positions of each pool (what rng.integers returned)."""
    return [[int(v) for v in rng.integers(0, len(pool), size=len(pool))] for pool in pools]


def counts_of(pools: list[list[int]], picks: list[list[int]], n_units: int) -> list[float]:
    counts = [0.0] * n_units
    for pool, pick in zip(pools, picks):
        for p in pick:
            counts[pool[p]] += 1.0
    return counts


def quantile_ci(values: list[float], total: int, level: float = 0.95):
    """Steps 4-5 for a list of replicate statistics."""
    finite = sorted(v for v in values if math.isfinite(v))
    if len(finite) == 0 or len(finite) < total / 2:
        return None
    lo, hi = ci_quantiles(level)
    a, b = np.quantile(np.array(finite, dtype=np.float64), [lo, hi], method="linear")
    return [float(a), float(b)]


def cluster_mean_draws(values, keys, strata, resamples: int, seed: int, stratified: bool):
    """Replicate means of `values` under the cluster bootstrap: sum_c counts[c] * sum_c / sum_c counts[c] * n_c.

    Units are the distinct (stratum, key); the sums run over the values of each unit in input order and the
    statistic accumulates over units in canonical order, left to right (plain floats, no pairwise summation).
    """
    strata = strata if strata is not None else [""] * len(values)
    by_unit: dict[tuple[str, str], list[float]] = {}
    for v, k, s in zip(values, keys, strata):
        by_unit.setdefault((s, k), []).append(v)
    units = list(by_unit)
    pools = canonical_pools(units, stratified)
    flat = [i for pool in pools for i in pool]  # canonical global order
    sums, sizes = [], []
    for i in range(len(units)):
        acc = 0.0
        for v in by_unit[units[i]]:
            acc += v
        sums.append(acc)
        sizes.append(float(len(by_unit[units[i]])))
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(resamples):
        counts = counts_of(pools, draw_indices(pools, rng), len(units))
        s = 0.0
        k = 0.0
        for i in flat:
            s += counts[i] * sums[i]
            k += counts[i] * sizes[i]
        out.append(s / k if k > 0 else float("nan"))
    return out


def _sha(values) -> str:
    return hashlib.sha256(np.asarray(values, dtype="<f8").tobytes()).hexdigest()


def _case(name, values, keys, strata, resamples, seed, stratified, level=0.95, keep_replicates=3):
    units = []
    seen = set()
    for k, s in zip(keys, strata if strata is not None else [""] * len(keys)):
        if (s, k) not in seen:
            seen.add((s, k))
            units.append((s, k))
    pools = canonical_pools(units, stratified)
    rng = np.random.default_rng(seed)
    first = [draw_indices(pools, rng) for _ in range(keep_replicates)]
    draws = cluster_mean_draws(values, keys, strata, resamples, seed, stratified)
    return {
        "name": name,
        "values": values,
        "keys": keys,
        "strata": strata,
        "resamples": resamples,
        "seed": seed,
        "stratified": stratified,
        "level": level,
        "units": [[s, k] for s, k in units],
        "pools": pools,
        "first_replicates": first,
        "draws_head": draws[:6],
        "draws_sha256": _sha(draws),
        "ci": quantile_ci(draws, resamples, level),
    }


def fixture() -> dict:
    g = np.random.default_rng(7)
    cats = ["article", "docs", "forum"]
    # A: stratified, 3 strata, clusters of 1-6 values
    vals_a, keys_a, strata_a = [], [], []
    for c in cats:
        for d in range(11):
            for _ in range(int(g.integers(1, 7))):
                vals_a.append(float(g.random()))
                keys_a.append(f"{c[0]}{d:02d}.example")
                strata_a.append(c)
    # B: not stratified, one stratum, 40 domains, a few values each
    vals_b, keys_b = [], []
    for d in range(40):
        for _ in range(int(g.integers(1, 5))):
            vals_b.append(float(g.random()) * 3 - 1)
            keys_b.append(f"site{d}.test")
    # C: key order by code point differs from UTF-16 order (U+FF5E is one unit 0xFF5E, U+1F600 is 0xD83D 0xDE00)
    keys_c = ["～a", "\U0001f600a", "b", "B", "z", "é", "e", "Z"] * 3
    vals_c = [float(g.random()) for _ in keys_c]
    strata_c = ["\U0001f600", "～", "x", "x", "x", "x", "x", "x"] * 3
    return {
        "format": "gran-prix.bootstrap-parity",
        "numpy": np.__version__,
        "cases": [
            _case("stratified-3-strata", vals_a, keys_a, strata_a, 500, 20261125, True),
            _case("flat-40-domains", vals_b, keys_b, None, 2000, 20261125, False),
            _case("flat-40-domains-80", vals_b, keys_b, None, 2000, 1, False, level=0.8),
            _case("codepoint-order", vals_c, keys_c, strata_c, 300, 3, True),
            _case("codepoint-order-flat", vals_c, keys_c, strata_c, 300, 3, False),
        ],
    }


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", help="write the parity fixture here (default: stdout)")
    args = ap.parse_args(argv)
    text = json.dumps(fixture(), indent=1, ensure_ascii=True, sort_keys=True) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
