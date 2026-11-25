#!/usr/bin/env python3
"""readability-lxml sidecar. NOT a baseline of the experiment (B1 is Readability.js, `@mozilla/readability` 0.6.0): it exists only
so the U2 sanity check can say whether the WCXB's unspecified "Readability" row is reproduced by the Python port.
Same JSON protocol as traf_sidecar.py: request {"docs": [{"key", "html", "url"}]} -> {"version", "results": [{"key", "text", "error"}]}."""
from __future__ import annotations

import json
import sys


def main() -> int:
    import lxml.html
    from readability import Document
    from importlib.metadata import version

    req = json.load(sys.stdin)
    results = []
    for d in req.get("docs", []):
        try:
            summary = Document(d["html"]).summary(html_partial=True)
            text = lxml.html.fromstring(summary).text_content() if summary.strip() else ""
            results.append({"key": d["key"], "text": text, "error": None})
        except Exception as e:  # noqa: BLE001
            results.append({"key": d["key"], "text": None, "error": f"{type(e).__name__}: {e}"})
    print(json.dumps({"version": version("readability-lxml"), "options": {}, "results": results}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
