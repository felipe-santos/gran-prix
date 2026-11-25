"""Bag-of-words F1 of protocol section 6.4 and the percentile bootstrap of section 6.5.

6.4: lowercase, tokens `[\\p{L}\\p{N}]+`, F1 of multisets between the system's text and the gold text.
The WCXB's own `evaluate.py` tokenizes with Python's `\\w+` (adds `_` and combining marks), so a second
variant (`tokens_wcxb`) is kept to cross-check the two conventions. An empty system output scores
F1 = 0 (never 1.0, section 6.2); only an empty gold text with an empty output scores 1.0, as in evaluate.py
(that can only be a broken ground truth, and the report counts such pages).
"""
from __future__ import annotations

import re
from collections import Counter

import numpy as np
import regex

_TOK = regex.compile(r"[\p{L}\p{N}]+")
_TOK_WCXB = re.compile(r"\w+")


def tokens(text: str | None) -> list[str]:
    return _TOK.findall((text or "").lower())


def tokens_wcxb(text: str | None) -> list[str]:
    return _TOK_WCXB.findall((text or "").lower())


def prf1(pred: list[str], ref: list[str]) -> tuple[float, float, float]:
    """(precision, recall, F1) of two token lists as multisets."""
    if not ref:
        return (1.0, 1.0, 1.0) if not pred else (0.0, 0.0, 0.0)
    if not pred:
        return (0.0, 0.0, 0.0)
    overlap = sum((Counter(pred) & Counter(ref)).values())
    p, r = overlap / len(pred), overlap / len(ref)
    return (p, r, 2 * p * r / (p + r) if p + r > 0 else 0.0)


def bow_f1(pred: str | None, ref: str | None, tokenizer=tokens) -> float:
    return prf1(tokenizer(pred), tokenizer(ref))[2]


def bootstrap_mean_ci(values: list[float], seed: int = 20261125, resamples: int = 10_000, level: float = 0.95) -> dict:
    """Percentile bootstrap CI of the mean over pages (one page per domain here: section 6.5)."""
    v = np.asarray(values, dtype=float)
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(v), size=(resamples, len(v)))
    means = v[idx].mean(axis=1)
    a = (1 - level) / 2
    lo, hi = np.quantile(means, [a, 1 - a])
    return {"mean": float(v.mean()), "ci_lo": float(lo), "ci_hi": float(hi), "n": int(len(v)), "resamples": resamples, "seed": seed}
