"""Minimal downloader for the pieces of WCXB that U2 needs.

WCXB: https://huggingface.co/datasets/murrough-foley/web-content-extraction-benchmark (CC-BY-4.0,
Foley 2026, doi 10.5281/zenodo.19316874). Pinned to one dataset revision. Reads the URL of every dev page from the first
bytes of its ground-truth file (~1 MB in total), then downloads the full ground truth and cached HTML of the
SAMPLED pages only. Standard library only. What it writes goes to `data/wcxb/` (gitignored): never commit it.
"""
from __future__ import annotations

import json
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = "murrough-foley/web-content-extraction-benchmark"
REVISION = "be72432cfa012ac918af47010bf106a2801afeef"
BASE = f"https://huggingface.co/datasets/{REPO}/resolve/{REVISION}"
_URL_RE = re.compile(r'"url":\s*"((?:[^"\\]|\\.)*)"')


def _get(url: str, rng: str | None = None) -> bytes:
    headers = {"User-Agent": "gran-prix-baselines/1"}
    if rng:
        headers["Range"] = f"bytes={rng}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as r:
        return r.read()


def dev_ids() -> list[str]:
    api = json.loads(_get(f"https://huggingface.co/api/datasets/{REPO}/revision/{REVISION}"))
    return sorted(s["rfilename"].rsplit("/", 1)[1][:-5] for s in api["siblings"] if s["rfilename"].startswith("dev/ground-truth/"))


def dev_urls(cache: Path) -> dict[str, str]:
    """id -> url for every dev page whose ground truth has one. Cached as JSON in `cache`."""
    if cache.exists():
        return json.loads(cache.read_text())

    def head(i: str) -> tuple[str, str | None]:
        text = _get(f"{BASE}/dev/ground-truth/{i}.json", "0-1199").decode("utf-8", "replace")
        m = _URL_RE.search(text)
        return i, (json.loads(f'"{m.group(1)}"') if m else None)

    with ThreadPoolExecutor(8) as ex:
        found = dict(ex.map(head, dev_ids()))
    # `url` not in the first bytes (other key order): the whole file, once.
    for i, u in list(found.items()):
        if u is None:
            found[i] = json.loads(_get(f"{BASE}/dev/ground-truth/{i}.json")).get("url")
    urls = {i: u for i, u in found.items() if u}
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(urls, indent=0, sort_keys=True))
    return urls


def fetch_pages(ids: list[str], out: Path) -> None:
    """Ground truth and HTML of `ids` into out/dev/{ground-truth,html}/ (skips files already there)."""
    for sub in ("ground-truth", "html"):
        (out / "dev" / sub).mkdir(parents=True, exist_ok=True)

    def one(job: tuple[str, str]) -> None:
        i, sub = job
        dest = out / "dev" / sub / f"{i}.{'json' if sub == 'ground-truth' else 'html'}"
        if not dest.exists():
            dest.write_bytes(_get(f"{BASE}/dev/{sub}/{dest.name}"))

    with ThreadPoolExecutor(8) as ex:
        list(ex.map(one, [(i, s) for i in ids for s in ("ground-truth", "html")]))
    meta = out / "metadata.json"
    if not meta.exists():
        meta.write_bytes(_get(f"{BASE}/metadata.json"))
