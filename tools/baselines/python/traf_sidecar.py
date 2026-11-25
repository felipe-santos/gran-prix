#!/usr/bin/env python3
"""Trafilatura sidecar (protocol section 7, B2). One process per batch, JSON in and out, no files.

    traf_sidecar.py --version            -> {"trafilatura": "2.4.0"}
    traf_sidecar.py < request.json       -> response on stdout

request:  {"options": {...}, "docs": [{"key": str, "html": str, "url": str|null}, ...]}
response: {"version": str, "options": {...effective...}, "results": [{"key", "text": str|null, "error": str|null}, ...]}

options (all optional):
  mode             "precision" | "default" | "recall"  -> favor_precision / neither / favor_recall (the three modes of B2)
  include_tables   default true      (Trafilatura's own default)
  include_comments default true      (Trafilatura's own default: forum replies are content for this benchmark)
  include_links    default false
  include_images   default false
  deduplicate      default false
  no_fallback      default false     (true = skip the readability/justext fallbacks)
Output is plain text: attributes are dropped, so the caller aligns it back to nodes by text (data-gp-id cannot survive).
"""
from __future__ import annotations

import json
import sys
import warnings

warnings.filterwarnings("ignore")

MODES = {"precision": {"favor_precision": True}, "default": {}, "recall": {"favor_recall": True}}
BOOL_DEFAULTS = {
    "include_tables": True,
    "include_comments": True,
    "include_links": False,
    "include_images": False,
    "deduplicate": False,
    "no_fallback": False,
}


def effective_options(raw: dict | None) -> dict:
    raw = raw or {}
    mode = raw.get("mode", "default")
    if mode not in MODES:
        raise ValueError(f"unknown mode {mode!r}; expected one of {sorted(MODES)}")
    unknown = set(raw) - set(BOOL_DEFAULTS) - {"mode"}
    if unknown:
        raise ValueError(f"unknown options: {sorted(unknown)}")
    return {"mode": mode, **{k: bool(raw.get(k, d)) for k, d in BOOL_DEFAULTS.items()}}


def kwargs_of(opts: dict) -> dict:
    return {**MODES[opts["mode"]], **{k: v for k, v in opts.items() if k != "mode"}}


def main() -> int:
    import trafilatura

    if "--version" in sys.argv[1:]:
        print(json.dumps({"trafilatura": trafilatura.__version__}))
        return 0
    req = json.load(sys.stdin)
    opts = effective_options(req.get("options"))
    kw = kwargs_of(opts)
    results = []
    for doc in req.get("docs", []):
        try:
            text = trafilatura.extract(doc["html"], url=doc.get("url"), output_format="txt", **kw)
            results.append({"key": doc["key"], "text": text, "error": None})
        except Exception as e:  # one broken page must not lose the batch
            results.append({"key": doc["key"], "text": None, "error": f"{type(e).__name__}: {e}"})
    print(json.dumps({"version": trafilatura.__version__, "options": opts, "results": results}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
