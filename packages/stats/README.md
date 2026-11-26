# @gran-prix/stats

The random generator pre-registered by the protocol (`numpy.random.default_rng(20261125)`, section 6.5, frozen in section 13) in pure TypeScript, with no dependencies, and the canonical cluster bootstrap built on it. `evaluate` (TS, `tools/cli`) and `scripts/decide-dom-v0.mjs` both import it, so there is one implementation of the resampling.

## What is bit-identical to NumPy 2.5.5

| Here | NumPy |
|---|---|
| `SeedSequence(entropy)` | `numpy.random.SeedSequence(entropy)` (integer entropy, no spawn key) |
| `PCG64(seed)` | `numpy.random.PCG64(seed)`: `nextUint64()` is `random_raw()`, `nextUint32()` is the bit generator's `next_uint32` (low half first, high half buffered) |
| `Generator.defaultRng(seed)` | `numpy.random.default_rng(seed)` |
| `.integers(low, high[, size])` | `Generator.integers(low, high, size)`, dtype int64 (the default), `endpoint=False`, scalar bounds |
| `quantileLinear(sorted, q)` | `numpy.quantile(sorted, q, method="linear")`, including its `b - (b - a) * (1 - t)` form for `t >= 0.5` |

The path of `integers` for `rng = high - low - 1`: `rng = 0` draws nothing; `rng = 2^32 - 1` takes one `next_uint32`; below that, Lemire's multiply-and-reject over `next_uint32` (the unbuffered 32-bit variant; the uint32 buffer of the bit generator carries over between calls); above, Lemire over `next_uint64`. Ranges above 2^53 are refused (the values would not be exact JS numbers).

The 128-bit LCG of PCG64 runs on four 32-bit limbs (no BigInt on the hot path); `test/pcg64.test.ts` checks it against a BigInt version of the same recurrence.

## The canonical bootstrap (the specification both languages implement)

Python reference: `tools/baselines/stats/bootstrap_ref.py`. TS: `src/bootstrap.ts`. A cluster is identified by `(stratum, key)`.

1. **Order.** Stratified: units sorted by `(stratum, key)`. Not stratified: by `(key, stratum)`. Strings compare by Unicode code point (Python's `sorted` on `str`; NOT JS's default `sort`, which compares UTF-16 units). A repeated `(stratum, key)` is an error.
2. **Pools.** One pool per stratum, in that order (a single pool with every unit when not stratified).
3. **Replicate `b = 0..B-1`.** For each pool, in order, ONE call `rng.integers(0, n, size=n)` on `rng = default_rng(seed)` (the same generator across the whole run, never re-seeded); the i-th value picks the unit at that position of the pool. `counts[unit]` is how many times a unit was picked. A pool of one unit still makes its call.
4. **Statistic.** A function of `counts`; every estimator sees the same counts (paired differences). Non-finite statistics are dropped; the interval is `null` if fewer than half of `B` remain.
5. **Interval.** `numpy.quantile(finite, [lo, hi], method="linear")` with `lo = round12((1 - level) / 2)` and `hi = round12(1 - lo)` (`round12` = 12 decimals), i.e. the 2.5% and 97.5% percentiles for level 0.95; for the one-sided lower bounds of the decision script, the quantile `round12(1 - level)`.

`clusterMeanDraws` is the statistic of the decision script (mean over all values drawn, every value weighs 1): a unit's sum runs over its values in input order and a replicate's mean accumulates over the units in canonical order, left to right.

## Tests and fixtures

- `test/fixtures/numpy-parity.json` and `test/fixtures/bootstrap-parity.json` are produced by the installed numpy (`tools/baselines/stats/gen_numpy_vectors.py`, `bootstrap_ref.py`). Seeds 0, 1, 20261125 (and big ones), ranges 1, 2, 7, 100, 2^31, 2^32 - 1, 2^32, 2^32 + 5, 2^40 + 1, 10^5 values each, plus sequences of calls on one generator (the buffer state matters).
- The TS tests need no Python. When `python3` can import numpy (`PYTHONPATH=tools/baselines/.pylibs` is added automatically), two extra tests regenerate both fixtures and demand identical bytes.
- To refresh: `PYTHONPATH=tools/baselines/.pylibs python3 tools/baselines/stats/gen_numpy_vectors.py --out packages/stats/test/fixtures/numpy-parity.json` (same for `bootstrap_ref.py --out .../bootstrap-parity.json`). A different NumPy minor changing a stream would show up as a test failure, not as a silent change.

Origin of the algorithms: NumPy (BSD-3-Clause) and the PCG family (MIT); see `NOTICE`.
