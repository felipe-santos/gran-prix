#!/usr/bin/env python3
"""U2 baseline sanity check (protocol section 2.4): Readability.js and Trafilatura on 150 WCXB dev pages.

    PYTHONPATH=tools/baselines/.pylibs python3 tools/baselines/u2/run_u2.py --data-dir data/wcxb [--variants] [--reference]

1. Sample: the first `n` dev pages ordered by sha256("gp-dom-v0|20261125|" + url) (same method as section 2.3).
2. Fetch ground truth and cached HTML of the sample only (WCXB, CC-BY-4.0; see README.md here).
3. Run both systems on the CACHED HTML (no browser, no flattening: WCXB ships the page as downloaded).
4. Score with the bag-of-words F1 of section 6.4 against `ground_truth.main_content`; mean over pages with a
   percentile bootstrap CI (section 6.5: B = 10 000, numpy default_rng(20261125)).
5. Compare each mean with the expected value of the protocol (Trafilatura 0.79 +- 0.04, Readability 0.67 +- 0.07).
--variants   also the other pre-registered configurations (Trafilatura precision/recall, Readability charThreshold 0/250): diagnostics only.
--reference  also the versions/implementations the WCXB figures most likely come from (Trafilatura 2.0.0, readability-lxml),
             run from tools/baselines/.pylibs-ref (requirements-ref.txt): they say whether a miss is the harness or the tool version.
Writes <data-dir>/u2-report.json. Exit code 0 even when a system is out of range (the report says so: investigate, fix, record).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASELINES = HERE.parent
sys.path.insert(0, str(HERE))

from bow import bootstrap_mean_ci, prf1, tokens, tokens_wcxb  # noqa: E402
from sample import SEED_PREFIX, sample_ids, url_hash  # noqa: E402
from wcxb import REVISION, dev_urls, fetch_pages  # noqa: E402

EXPECTED = {"trafilatura": (0.79, 0.04), "readability": (0.67, 0.07)}
N_DEFAULT = 150
PYLIBS = BASELINES / ".pylibs"
PYLIBS_REF = BASELINES / ".pylibs-ref"


def _sub(cmd: list[str], docs: list[dict], pylibs: Path | None = None) -> dict:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    if pylibs is not None:
        env["PYTHONPATH"] = str(pylibs)
    p = subprocess.run(cmd, input=json.dumps({"docs": docs, "options": None}), capture_output=True, text=True, check=True, cwd=HERE, env=env)
    return json.loads(p.stdout)


def run_readability_js(docs: list[dict], options: dict) -> dict:
    return _sub(["node", str(HERE / "readability_extract.mjs"), json.dumps(options)], docs)


def run_trafilatura(docs: list[dict], options: dict, pylibs: Path = PYLIBS) -> dict:
    p = subprocess.run([sys.executable, str(BASELINES / "python" / "traf_sidecar.py")], input=json.dumps({"docs": docs, "options": options}),
                       capture_output=True, text=True, check=True, env={**os.environ, "PYTHONPATH": str(pylibs), "PYTHONDONTWRITEBYTECODE": "1"})
    return json.loads(p.stdout)


def run_readability_lxml(docs: list[dict], options: dict) -> dict:
    return _sub([sys.executable, str(BASELINES / "python" / "rl_sidecar.py")], docs, PYLIBS_REF)


# role: primary = the experiment's configuration (verdict); variant = other pre-registered configs; reference = WCXB-version check.
# (family, label, options, runner, role)
SYSTEMS = [
    ("trafilatura", "default", {"mode": "default"}, run_trafilatura, "primary"),
    ("readability", "charThreshold=500", {"charThreshold": 500}, run_readability_js, "primary"),
    ("trafilatura", "precision", {"mode": "precision"}, run_trafilatura, "variant"),
    ("trafilatura", "recall", {"mode": "recall"}, run_trafilatura, "variant"),
    ("trafilatura", "default,no-comments", {"mode": "default", "include_comments": False}, run_trafilatura, "variant"),
    ("readability", "charThreshold=0", {"charThreshold": 0}, run_readability_js, "variant"),
    ("readability", "charThreshold=250", {"charThreshold": 250}, run_readability_js, "variant"),
    ("trafilatura", "default", {"mode": "default"}, lambda d, o: run_trafilatura(d, o, PYLIBS_REF), "reference"),
    ("readability", "readability-lxml", {}, run_readability_lxml, "reference"),
]


def score(results: list[dict], gold: dict[str, str], page_type: dict[str, str]) -> dict:
    f1s, f1s_w, ps, rs = [], [], [], []
    by_type: dict[str, list[float]] = defaultdict(list)
    per_page, empty = {}, 0
    for r in results:
        ref, blank = gold[r["key"]], not (r["text"] or "").strip()
        empty += blank
        p, rc, f1 = prf1(tokens(r["text"]), tokens(ref))
        f1w = prf1(tokens_wcxb(r["text"]), tokens_wcxb(ref))[2]
        f1s.append(f1); f1s_w.append(f1w); ps.append(p); rs.append(rc)
        by_type[page_type[r["key"]]].append(f1)
        per_page[r["key"]] = {"f1": round(f1, 4), "f1_wcxb_tokens": round(f1w, 4), "empty": blank, "error": r["error"]}
    return {
        "f1_bow": bootstrap_mean_ci(f1s),
        "f1_bow_wcxb_tokenizer": bootstrap_mean_ci(f1s_w),
        "precision": sum(ps) / len(ps),
        "recall": sum(rs) / len(rs),
        "empty_outputs": empty,
        "errors": sum(1 for r in results if r["error"]),
        "by_page_type": {t: {"n": len(v), "f1": sum(v) / len(v)} for t, v in sorted(by_type.items())},
        "per_page": per_page,
    }


def verdict(family: str, mean: float, ci: tuple[float, float]) -> dict:
    center, tol = EXPECTED[family]
    lo, hi = center - tol, center + tol
    where = "inside" if lo <= mean <= hi else ("above" if mean > hi else "below")
    return {"expected": center, "tolerance": tol, "range": [round(lo, 4), round(hi, 4)], "mean_vs_range": where,
            "mean_in_range": where == "inside", "ci_overlaps_range": ci[0] <= hi and ci[1] >= lo}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", required=True, type=Path, help="where WCXB pieces and u2-report.json go (gitignored data/wcxb)")
    ap.add_argument("--n", type=int, default=N_DEFAULT)
    ap.add_argument("--variants", action="store_true")
    ap.add_argument("--reference", action="store_true")
    ap.add_argument("--out", type=Path, default=None, help="report path (default <data-dir>/u2-report.json)")
    a = ap.parse_args()

    urls = dev_urls(a.data_dir / "dev-urls.json")
    ids = sample_ids(urls, a.n)
    fetch_pages(ids, a.data_dir)
    meta = json.loads((a.data_dir / "metadata.json").read_text())["files"]
    page_type = {i: ("collection" if meta[i]["page_type"] == "category" else meta[i]["page_type"]) for i in ids}
    gold, docs = {}, []
    for i in ids:
        gt = json.loads((a.data_dir / "dev" / "ground-truth" / f"{i}.json").read_text())
        gold[i] = (gt.get("ground_truth") or {}).get("main_content") or ""
        docs.append({"key": i, "html": (a.data_dir / "dev" / "html" / f"{i}.html").read_text(encoding="utf-8", errors="replace"), "url": urls[i]})

    systems = {}
    for family, label, options, runner, role in SYSTEMS:
        if role == "variant" and not a.variants or role == "reference" and not a.reference:
            continue
        out = runner(docs, options)
        res = score(out["results"], gold, page_type)
        res.update({"family": family, "role": role, "version": out["version"], "options": out.get("options", options)})
        ci = res["f1_bow"]
        res["check"] = verdict(family, ci["mean"], (ci["ci_lo"], ci["ci_hi"]))
        key = f"{family}@{out['version']}:{label}" if family == "trafilatura" or role == "reference" else f"readability.js@{out['version']}:{label}"
        systems[key] = res
        print(f"{role:9} {key:44} F1 {ci['mean']:.3f} [{ci['ci_lo']:.3f}, {ci['ci_hi']:.3f}]  P {res['precision']:.3f} R {res['recall']:.3f}"
              f"  {res['check']['mean_vs_range']:6} {res['check']['range']}  empty {res['empty_outputs']}", flush=True)

    types = defaultdict(int)
    for t in page_type.values():
        types[t] += 1
    report = {
        "protocol": "experimento-dom-v0 section 2.4 U2",
        "dataset": {"name": "WCXB", "license": "CC-BY-4.0", "revision": REVISION, "citation": "Foley (2026), doi 10.5281/zenodo.19316874"},
        "sampling": {
            "method": f'ascending sha256("{SEED_PREFIX}" + url) over the dev pages that have a url; first n',
            "n": len(ids), "dev_pages_with_url": len(urls), "ids": ids, "sha256": {i: url_hash(urls[i]) for i in ids},
            "by_page_type": dict(sorted(types.items())), "pages_with_empty_gold": [i for i in ids if not tokens(gold[i])],
        },
        "metric": "bag-of-words F1 (section 6.4: lowercase, [\\p{L}\\p{N}]+ tokens), mean per page; bootstrap CI 95%, B=10000, default_rng(20261125)",
        "systems": systems,
        "primary_all_inside_range": all(s["check"]["mean_in_range"] for s in systems.values() if s["role"] == "primary"),
    }
    out_path = a.out or (a.data_dir / "u2-report.json")
    out_path.write_text(json.dumps(report, indent=1, ensure_ascii=False))
    print(f"wrote {out_path}; primary systems all inside range: {report['primary_all_inside_range']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
