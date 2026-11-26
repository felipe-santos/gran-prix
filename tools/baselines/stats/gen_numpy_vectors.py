"""Test vectors of numpy.random (PCG64, SeedSequence, Generator.integers) and numpy.quantile, for the
TypeScript port in packages/stats (packages/stats/test/numpy-parity.test.ts).

Everything is produced by the installed numpy, nothing is computed here. Long sequences are kept as the first
values plus the SHA-256 of all of them as little-endian int64, so the fixture stays small.

    PYTHONPATH=tools/baselines/.pylibs python3 tools/baselines/stats/gen_numpy_vectors.py \
        --out packages/stats/test/fixtures/numpy-parity.json

Without --out the JSON goes to stdout (the TS suite regenerates it that way and compares, when numpy is there).
Big integers are decimal strings (they do not fit a JS number).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys

import numpy as np

SEEDS = [0, 1, 20261125, 2**32, 2**40 + 3, 2**130 + 12345]
RANGES = [1, 2, 7, 100, 2**31, 2**32 - 1, 2**32, 2**32 + 5, 2**40 + 1]
LONG = 100_000
HEAD = 16
# (low, high, size) executed one after the other on the SAME generator: the uint32 buffer carries over
CALL_SCRIPT = [
    (0, 7, 3), (0, 100, 5), (0, 2**32 + 5, 2), (0, 7, 1), (0, 1, 4), (0, 2**31, 3), (0, 7, 5),
    (-3, 4, 6), (0, 7, 1), (0, 7, 1), (0, 2**32, 3), (10, 11, 2), (0, 2**32 - 1, 3), (5, 5 + 2**33, 3), (0, 3, 1),
]


def sha_i64(values) -> str:
    return hashlib.sha256(np.asarray(values, dtype="<i8").tobytes()).hexdigest()


def raw_case(seed: int) -> dict:
    bg = np.random.PCG64(seed)
    st = bg.state["state"]
    return {
        "seed": str(seed),
        "state": str(st["state"]),
        "inc": str(st["inc"]),
        "raw": [str(int(v)) for v in bg.random_raw(8)],
    }


def integers_case(seed: int, n: int) -> dict:
    v = np.random.default_rng(seed).integers(0, n, size=LONG)
    return {"seed": str(seed), "high": str(n), "head": [int(x) for x in v[:HEAD]], "tail": [int(x) for x in v[-4:]], "sha256": sha_i64(v), "max": int(v.max())}


def script_case(seed: int) -> dict:
    rng = np.random.default_rng(seed)
    out = []
    for low, high, size in CALL_SCRIPT:
        out.append([int(x) for x in rng.integers(low, high, size=size)])
    return {"seed": str(seed), "calls": [list(c) for c in CALL_SCRIPT], "out": out}


def long_script_case(seed: int) -> dict:
    """2000 calls of 1..5 values over a rotating set of ranges, many of size 1: the buffer parity in volume."""
    rng = np.random.default_rng(seed)
    highs = [7, 100, 2**32 + 5, 3, 2**31, 1, 1000]
    calls, flat = [], []
    for i in range(2000):
        high, size = highs[i % len(highs)], 1 + (i * 7) % 5
        calls.append([0, high, size])
        flat.extend(int(x) for x in rng.integers(0, high, size=size))
    return {"seed": str(seed), "calls_rule": "i in 0..1999: high = [7,100,2**32+5,3,2**31,1,1000][i % 7], size = 1 + (i*7) % 5, low = 0", "n": len(flat), "sha256": sha_i64(flat), "head": flat[:HEAD]}


def scalar_case(seed: int) -> dict:
    rng = np.random.default_rng(seed)
    return {"seed": str(seed), "values": [int(rng.integers(0, 6)) for _ in range(20)] + [int(rng.integers(0, 2**32 + 5)) for _ in range(4)]}


def quantile_cases() -> list:
    g = np.random.default_rng(11)
    qs = [0.0, 0.025, 0.05, 0.1, 0.3333333333333333, 0.5, 0.9, 0.95, 0.975, 1.0]
    cases = []
    for n in [1, 2, 3, 10, 47, 1000]:
        arr = np.sort(g.standard_normal(n) * 10)
        cases.append({"sorted": [float(x) for x in arr], "q": qs, "out": [float(np.quantile(arr, q, method="linear")) for q in qs]})
    return cases


def vectors() -> dict:
    return {
        "format": "gran-prix.numpy-parity",
        "numpy": np.__version__,
        "raw": [raw_case(s) for s in SEEDS],
        "integers": [integers_case(s, n) for s in SEEDS[:3] for n in RANGES],
        "scripts": [script_case(s) for s in SEEDS[:3]],
        "long_scripts": [long_script_case(s) for s in SEEDS[:3]],
        "scalars": [scalar_case(s) for s in SEEDS[:3]],
        "quantiles": quantile_cases(),
    }


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", help="write the vectors here (default: stdout)")
    args = ap.parse_args(argv)
    text = json.dumps(vectors(), indent=1, sort_keys=True) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
