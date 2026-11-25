"""Shared test helpers: path setup and a tiny synthetic binary Dataset directory."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "2")  # tiny data: threads only add contention (set before sklearn loads)

import numpy as np  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
for sub in ("u2", "python", "gbdt"):
    sys.path.insert(0, str(ROOT / sub))
PYLIBS = ROOT / ".pylibs"
if PYLIBS.exists():
    sys.path.insert(0, str(PYLIBS))


def make_dataset(out: Path, n_domains: int = 12, rows_per_page: int = 24, seed: int = 7, dim: int = 4) -> Path:
    """Domains d0..: every domain has 1-2 pages; train gets the first 6 domains, val 2, test the rest.
    y = 1 when x0 + noise > 0 (learnable); w = own-text chars (positive ints); u = unit index inside the page."""
    rng = np.random.default_rng(seed)
    out.mkdir(parents=True, exist_ok=True)
    split_of = lambda d: "train" if d < 6 else ("val" if d < 8 else "test")  # noqa: E731
    groups, files = [], {"train": [], "val": [], "test": []}
    for d in range(n_domains):
        for pg in range(1 + d % 2):
            gid = f"page-d{d}-{pg}#aaaaaaaaaaaa"
            n_pos = 0
            for u in range(rows_per_page):
                x = rng.normal(size=dim)
                y = int(x[0] + 0.3 * rng.normal() > 0)
                n_pos += y
                files[split_of(d)].append({"g": gid, "u": u * 3 + 1, "x": [round(float(v), 6) for v in x], "y": y, "s": "human", "w": int(rng.integers(5, 400))})
            groups.append({"group_id": gid, "group_key": f"domain{d}.example", "stratum": "article" if d % 3 else "forum", "split": split_of(d), "bucket": 0, "n_rows": rows_per_page, "n_pos": n_pos})
    for name, rows in files.items():
        (out / f"{name}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    manifest = {
        "dataset_id": "sha256:" + "0" * 64, "feature_schema_id": "sha256:" + "1" * 64, "dim": dim, "row_weight": "own_text_chars",
        "label_space": {"kind": "binary", "classes": ["drop", "keep"]}, "groups": sorted(groups, key=lambda g: g["group_id"]),
        "split": {"scheme": "hash-bucket-v1", "kfold": {"k": 3}},
    }
    (out / "manifest.json").write_text(json.dumps(manifest))
    return out
