"""Seeded sampling of section 2.3 applied to the WCXB dev pages (section 2.4, U2).

Order = ascending `sha256("gp-dom-v0|20261125|" + url)` (hex digest); the first `n` candidates are the sample.
A candidate with no `url` in its ground truth cannot be hashed and is not in the frame (the caller reports them).
"""
from __future__ import annotations

import hashlib

SEED_PREFIX = "gp-dom-v0|20261125|"


def url_hash(url: str) -> str:
    return hashlib.sha256((SEED_PREFIX + url).encode("utf-8")).hexdigest()


def sample_ids(urls: dict[str, str], n: int) -> list[str]:
    """`urls`: file id -> url. Returns the first `n` ids in hash order (ties broken by id)."""
    return [i for _, i in sorted((url_hash(u), i) for i, u in urls.items())[:n]]
