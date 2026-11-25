#!/usr/bin/env python3
"""Offline GBDT baseline (protocol section 7, B5; gate G0 in section 8). Never shipped in the product.

    PYTHONPATH=tools/baselines/.pylibs python3 tools/baselines/gbdt/gbdt.py --dataset <Dataset dir> --out <dir> [--seed 1]

Reads a binary `Dataset` (manifest.json + train/val/test.jsonl: rows {g, u, x, y, s, w?}), uses the SAME features,
rows and weights as the MLP (`w` = own-text characters when the manifest declares row_weight), and writes prediction
Bundles that evaluate's `baselines` port takes (predictions.jsonl of {g, u, p} + system.json {id, threshold}).

Why sklearn `HistGradientBoostingClassifier`: it is what the protocol names (B5), it is deterministic for a fixed
seed when early stopping is off (no hidden validation split), takes `sample_weight` natively and needs no compiler
(LightGBM would add a native wheel for no benefit at this data size).

Protocol rules implemented here:
  * tuning ONLY on dev = train + val; the test split is read only to be scored, once, by the frozen model;
  * grouped CV by domain (the manifest's `group_key`): a domain never straddles two folds; k = manifest `split.kfold.k` (default 5);
  * at most 12 configurations (`CONFIGS`, fixed a priori in this file, selected by the dev OOF macro-per-page F1 at tau*);
  * tau* = the largest threshold whose character-weighted recall is >= 0.95 on the dev OOF predictions (section 6.3);
  * dev OOF predictions are NESTED: for each outer fold the 12 configurations are tuned by an inner grouped CV on the
    other folds only, so a dev page's prediction never depends on its own labels or on a choice made with them.
Outputs under --out: bundle-dev-oof/, bundle-<split>/ for each --emit split, gbdt-report.json.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import sys
import time
from pathlib import Path

import numpy as np

MAX_CONFIGS = 12
RECALL_TARGET = 0.95
# 2 learning rates x 3 (leaves, min leaf) x 2 L2 = 12 configurations, fixed before looking at any data.
CONFIGS = [
    {"learning_rate": lr, "max_leaf_nodes": leaves, "min_samples_leaf": leaf, "l2_regularization": l2, "max_iter": 200}
    for lr, (leaves, leaf), l2 in itertools.product([0.05, 0.1], [(15, 20), (31, 20), (63, 50)], [0.0, 1.0])
]
assert len(CONFIGS) <= MAX_CONFIGS


# ------------------------------------------------------------------ data
class Rows:
    def __init__(self, g: np.ndarray, u: np.ndarray, x: np.ndarray, y: np.ndarray, w: np.ndarray, split: np.ndarray):
        self.g, self.u, self.x, self.y, self.w, self.split = g, u, x, y, w, split

    def __len__(self) -> int:
        return len(self.y)

    def take(self, idx: np.ndarray) -> "Rows":
        return Rows(self.g[idx], self.u[idx], self.x[idx], self.y[idx], self.w[idx], self.split[idx])


def read_dataset(path: Path, splits: tuple[str, ...] = ("train", "val", "test")) -> tuple[dict, Rows, dict[str, str]]:
    """(manifest, rows of the given splits, group_id -> group_key)."""
    manifest = json.loads((path / "manifest.json").read_text())
    if manifest.get("label_space", {}).get("kind") != "binary":
        raise SystemExit("the dataset must have a binary label space (project the labels first)")
    weighted = manifest.get("row_weight") is not None
    g, u, x, y, w, sp = [], [], [], [], [], []
    for s in splits:
        f = path / f"{s}.jsonl"
        if not f.exists():
            continue
        for line in f.read_text().splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            g.append(r["g"]); u.append(r["u"]); x.append(r["x"]); y.append(r["y"]); sp.append(s)
            w.append(r["w"] if weighted else 1.0)
    rows = Rows(np.array(g, dtype=object), np.array(u, dtype=np.int64), np.array(x, dtype=np.float64).reshape(len(y), manifest["dim"]),
                np.array(y, dtype=np.int64), np.array(w, dtype=np.float64), np.array(sp, dtype=object))
    return manifest, rows, {gr["group_id"]: gr["group_key"] for gr in manifest["groups"]}


# ------------------------------------------------------------------ grouped folds, metrics
def grouped_folds(keys: np.ndarray, weights: np.ndarray, k: int) -> np.ndarray:
    """Fold id per row such that every key (domain) lives in ONE fold. Deterministic and balanced: keys sorted by
    (-rows, key) go one by one to the currently lightest fold (ties: lowest fold id). No randomness, so no seed."""
    uniq, inv, cnt = np.unique(keys.astype(str), return_inverse=True, return_counts=True)
    order = sorted(range(len(uniq)), key=lambda i: (-cnt[i], uniq[i]))
    load = [0] * k
    fold_of = np.zeros(len(uniq), dtype=np.int64)
    for i in order:
        f = min(range(k), key=lambda j: (load[j], j))
        fold_of[i] = f
        load[f] += int(cnt[i])
    return fold_of[inv]


def tau_star(p: np.ndarray, y: np.ndarray, w: np.ndarray, target: float = RECALL_TARGET) -> float:
    """Largest tau with character-weighted recall of `p >= tau` at least `target` (section 6.3)."""
    pos = y == 1
    total = float(w[pos].sum())
    if total <= 0:
        return 0.5
    o = np.argsort(-p, kind="stable")
    ps, wp = p[o], np.where(pos[o], w[o], 0.0)
    cum = np.cumsum(wp)
    # last index of each run of equal scores: only there is "p >= tau" a well-defined cut
    last = np.r_[ps[1:] != ps[:-1], True]
    ok = np.nonzero(last & (cum >= target * total - 1e-12))[0]
    return float(ps[ok[0]]) if len(ok) else float(ps[-1])


def macro_page_f1(p: np.ndarray, y: np.ndarray, w: np.ndarray, pages: np.ndarray, tau: float) -> float:
    """Mean over pages of the char-weighted F1 of `p >= tau` (empty output = F1 0, section 6.2)."""
    if len(y) == 0:
        return 0.0
    pred = p >= tau
    _, inv = np.unique(pages.astype(str), return_inverse=True)
    n = int(inv.max()) + 1
    sums = lambda mask: np.bincount(inv, weights=np.where(mask, w, 0.0), minlength=n)  # noqa: E731
    tp, fp, fn = sums(pred & (y == 1)), sums(pred & (y == 0)), sums(~pred & (y == 1))
    den = 2 * tp + fp + fn
    return float(np.mean(np.where(den > 0, 2 * tp / np.where(den > 0, den, 1.0), 0.0)))


# ------------------------------------------------------------------ model
def fit(cfg: dict, rows: Rows, seed: int):
    from sklearn.ensemble import HistGradientBoostingClassifier

    m = HistGradientBoostingClassifier(early_stopping=False, random_state=seed, **cfg)
    m.fit(rows.x, rows.y, sample_weight=rows.w)
    return m


def predict(model, x: np.ndarray) -> np.ndarray:
    if len(x) == 0:
        return np.zeros(0)
    return model.predict_proba(x)[:, 1] if len(model.classes_) == 2 else np.full(len(x), float(model.classes_[0] == 1))


def cv_scores(rows: Rows, keys: np.ndarray, k: int, configs: list[dict], seed: int) -> tuple[list[float], list[np.ndarray]]:
    """Per configuration: dev macro-page F1 at the config's own OOF tau*, and its OOF probabilities."""
    folds = grouped_folds(keys, rows.w, k)
    scores, oofs = [], []
    for cfg in configs:
        oof = np.zeros(len(rows))
        for f in range(k):
            tr, te = folds != f, folds == f
            if not te.any() or not tr.any():
                continue
            oof[te] = predict(fit(cfg, rows.take(np.nonzero(tr)[0]), seed), rows.x[te])
        t = tau_star(oof, rows.y, rows.w)
        scores.append(macro_page_f1(oof, rows.y, rows.w, rows.g, t))
        oofs.append(oof)
    return scores, oofs


def best_config(scores: list[float]) -> int:
    return int(max(range(len(scores)), key=lambda i: (round(scores[i], 12), -i)))  # ties: the earlier (simpler) config


# ------------------------------------------------------------------ bundles
def write_bundle(d: Path, system_id: str, threshold: float, rows: Rows, p: np.ndarray) -> None:
    d.mkdir(parents=True, exist_ok=True)
    (d / "system.json").write_text(json.dumps({"id": system_id, "threshold": threshold}) + "\n")
    with (d / "predictions.jsonl").open("w") as fh:
        for g, u, pi in zip(rows.g, rows.u, p):
            fh.write(json.dumps({"g": str(g), "u": int(u), "p": round(float(pi), 6)}) + "\n")


def run(dataset: Path, out: Path, seed: int = 1, emit: tuple[str, ...] = ("test",), folds: int | None = None, inner_folds: int = 3,
        nested: bool = True, configs: list[dict] | None = None, system_id: str = "gbdt") -> dict:
    import sklearn

    t0 = time.time()
    configs = configs or CONFIGS
    if len(configs) > MAX_CONFIGS:
        raise SystemExit(f"{len(configs)} configurations > the protocol budget of {MAX_CONFIGS}")
    manifest, rows, group_key = read_dataset(dataset)
    k = folds or (manifest.get("split", {}).get("kfold") or {}).get("k") or 5
    dev = np.nonzero(np.isin(rows.split, ["train", "val"]))[0]
    devrows = rows.take(dev)
    keys = np.array([group_key.get(str(g), str(g)) for g in devrows.g], dtype=object)

    # 1) model selection on all of dev (grouped CV, <= 12 configs)
    scores, oofs = cv_scores(devrows, keys, k, configs, seed)
    sel = best_config(scores)
    # 2) nested dev OOF: tuning repeated inside every outer fold, on the other folds only
    outer = grouped_folds(keys, devrows.w, k)
    oof_nested = np.zeros(len(devrows))
    picked = []
    for f in range(k):
        tr, te = np.nonzero(outer != f)[0], np.nonzero(outer == f)[0]
        if len(te) == 0 or len(tr) == 0:
            picked.append(None)
            continue
        trr = devrows.take(tr)
        if nested:
            s_in, _ = cv_scores(trr, keys[tr], inner_folds, configs, seed)
            c = best_config(s_in)
        else:
            c = sel
        picked.append(c)
        oof_nested[te] = predict(fit(configs[c], trr, seed), devrows.x[te])
    tau = tau_star(oof_nested, devrows.y, devrows.w)
    # 3) the frozen model: selected config refit on ALL of dev, tau* from the nested OOF
    final = fit(configs[sel], devrows, seed)

    write_bundle(out / "bundle-dev-oof", f"{system_id}", tau, devrows, oof_nested)
    emitted = {}
    for s in emit:
        idx = np.nonzero(rows.split == s)[0]
        sr = rows.take(idx)
        write_bundle(out / f"bundle-{s}", system_id, tau, sr, predict(final, sr.x))
        emitted[s] = int(len(sr))
    strata = {gr["group_id"]: gr["stratum"] for gr in manifest["groups"]}
    report = {
        "tool": "tools/baselines/gbdt/gbdt.py", "model": "sklearn.ensemble.HistGradientBoostingClassifier", "sklearn": sklearn.__version__,
        "numpy": np.__version__, "seed": seed, "folds": k, "inner_folds": inner_folds, "nested": nested,
        "dataset_id": manifest.get("dataset_id"), "feature_schema_id": manifest.get("feature_schema_id"), "dim": manifest["dim"],
        "dev": {"rows": int(len(devrows)), "pages": int(len(np.unique(devrows.g.astype(str)))), "domains": int(len(np.unique(keys.astype(str))))},
        "weights": "row.w (own-text chars)" if manifest.get("row_weight") else "1 per row",
        "configs": [{"config": c, "dev_cv_macro_page_f1_at_tau": round(s, 6)} for c, s in zip(configs, scores)],
        "selected": {"index": sel, "config": configs[sel]},
        "outer_fold_selection": picked,
        "tau_star": tau, "tau_rule": f"largest threshold with char-weighted recall >= {RECALL_TARGET} on the nested dev OOF",
        "dev_oof_macro_page_f1_at_tau": round(macro_page_f1(oof_nested, devrows.y, devrows.w, devrows.g, tau), 6),
        "dev_oof_macro_page_f1_by_stratum": {
            st: round(macro_page_f1(oof_nested[m], devrows.y[m], devrows.w[m], devrows.g[m], tau), 6)
            for st in sorted(set(strata.values()))
            if (m := np.array([strata.get(str(g)) == st for g in devrows.g])).any()
        },
        "emitted_splits": emitted, "seconds": round(time.time() - t0, 1),
        "predictions_sha256": {p.parent.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.glob("bundle-*/predictions.jsonl"))},
    }
    (out / "gbdt-report.json").write_text(json.dumps(report, indent=1) + "\n")
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", required=True, type=Path, help="Dataset directory (manifest.json, train/val/test.jsonl)")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--emit", default="test", help="comma-separated splits scored by the frozen model (default test); dev OOF is always written")
    ap.add_argument("--folds", type=int, default=None, help="outer folds (default: manifest split.kfold.k, else 5)")
    ap.add_argument("--inner-folds", type=int, default=3)
    ap.add_argument("--no-nested", action="store_true", help="reuse the all-dev selection inside every outer fold (faster, slightly optimistic OOF)")
    ap.add_argument("--system-id", default="gbdt")
    a = ap.parse_args()
    r = run(a.dataset, a.out, a.seed, tuple(s for s in a.emit.split(",") if s), a.folds, a.inner_folds, not a.no_nested, system_id=a.system_id)
    print(f"selected config {r['selected']['index']} {r['selected']['config']}; tau* {r['tau_star']:.4f}; dev OOF macro-page F1 {r['dev_oof_macro_page_f1_at_tau']:.4f}; {r['seconds']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
