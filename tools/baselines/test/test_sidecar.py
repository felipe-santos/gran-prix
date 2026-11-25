"""The sidecar end to end (needs trafilatura in tools/baselines/.pylibs; skipped, loudly, when it is not installed)."""
import json
import os
import subprocess
import sys
import unittest

import helpers

try:
    import trafilatura  # noqa: F401
    HAVE = True
except ImportError:
    HAVE = False

PAGE = """<html><head><title>Bees on the roof</title></head><body>
<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/shop">Shop</a></nav>
<article><h1>Bees on the roof</h1>
<p>Across the old harbour district, a handful of hobbyists are turning flat tar roofs into small, humming farms that supply the neighbourhood with honey.</p>
<p>Each morning the keepers climb a service ladder with a smoker and a thermos, check the entrances of the hive boxes and note how much pollen the foragers carry home.</p>
<p>By late summer the colonies have filled their supers and the first harvest is spun in a borrowed kitchen, jar by jar, for the market stall.</p>
</article><footer>Copyright 2026 Example Inc. All rights reserved. Privacy Terms Cookies</footer></body></html>"""


@unittest.skipUnless(HAVE, "trafilatura not installed: pip install --target tools/baselines/.pylibs -r tools/baselines/requirements.txt")
class SidecarProcess(unittest.TestCase):
    def call(self, options):
        req = {"options": options, "docs": [{"key": "a", "html": PAGE, "url": "https://example.com/blog/bees"}, {"key": "b", "html": "", "url": None}]}
        p = subprocess.run([sys.executable, str(helpers.ROOT / "python" / "traf_sidecar.py")], input=json.dumps(req), capture_output=True, text=True,
                           env={**os.environ, "PYTHONPATH": str(helpers.PYLIBS)}, check=True)
        return json.loads(p.stdout)

    def test_extracts_the_article_not_the_chrome_and_reports_version_and_options(self):
        r = self.call({"mode": "recall"})
        self.assertRegex(r["version"], r"^\d+\.\d+\.\d+$")
        self.assertEqual(r["options"]["mode"], "recall")
        text = r["results"][0]["text"]
        self.assertIn("humming farms", text)
        self.assertNotIn("Copyright 2026", text)
        self.assertEqual([x["key"] for x in r["results"]], ["a", "b"])  # input order, one result per doc
        self.assertIsNone(r["results"][1]["text"])  # empty html: no output, no crash
        self.assertIsNone(r["results"][1]["error"])

    def test_is_deterministic(self):
        self.assertEqual(self.call({"mode": "default"}), self.call({"mode": "default"}))

    def test_version_flag(self):
        p = subprocess.run([sys.executable, str(helpers.ROOT / "python" / "traf_sidecar.py"), "--version"], capture_output=True, text=True,
                           env={**os.environ, "PYTHONPATH": str(helpers.PYLIBS)}, check=True)
        self.assertIn("trafilatura", json.loads(p.stdout))


if __name__ == "__main__":
    unittest.main()
