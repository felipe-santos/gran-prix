#!/usr/bin/env python3
"""Run trafilatura over a list of HTML files. Usage: traf_extract.py file1.html file2.html ...
Prints one JSON object {path: extracted_text_or_null} on stdout. Text output only: trafilatura's
XML/HTML output drops attributes, so alignment back to data-gp-id must be text-based anyway."""
import json
import sys
import warnings

warnings.filterwarnings("ignore")
import trafilatura  # noqa: E402

out = {}
for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as fh:
        html = fh.read()
    out[path] = trafilatura.extract(html, output_format="txt", include_tables=True, include_comments=False)
print(json.dumps({"version": trafilatura.__version__, "results": out}))
