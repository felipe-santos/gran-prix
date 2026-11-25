# Spike: stable `data-gp-id` stamping and Readability/Trafilatura alignment

Answers the open question "does Readability preserve `data-gp-id`?" and de-risks feature extraction (E1.4), collection (E1.5) and labeling by disagreement (E2.6).

- Run date: 2026-11-25. Results re-run and confirmed by the coordinator on the integrated branch.
- Tools: Chromium 1254 headless via `playwright-core` 1.65, `@mozilla/readability` 0.6.0, `trafilatura` 2.4.0 (installed outside the repo).

## TL;DR

1. **Readability keeps `data-gp-id` on most kept elements, but loses it systematically.**
   - On the 12 fixtures it keeps 155/181 (85.6%) truth-main text elements on a plain `cloneNode(true)`, and 164/181 (90.6%) once open shadow roots are inlined.
   - Of the 17 misses, 9 are the page `<h1>`, which Readability deletes by design when it duplicates the title. The other 8 are a real selection error on one landing page.
2. **Id survival is not safe as the only labeling primitive.**
   - When Readability keeps a text-only `<div>`, it wraps the text in a new `<p>` with no attributes and replaces the div with it (`Readability.js` ~1166–1196). The text survives; the id does not.
   - On the fixtures, 20 of 305 kept text elements lost their id this way (all `div`s), and 0 of the 164 main elements did.
   - On real pages: 50 such divs on a Hacker News thread, 35 on react.dev and 7 on Wikipedia.
   - These are dates, author boxes, comment bodies and ratings, exactly what a 3-class label needs.
3. **Text→node alignment works and is cheap.**
   - A beam DP over "cursor in the extractor text" explained 100% of Readability's text on all 12 fixtures and all 5 real pages, and recovered every element whose id was lost.
   - It does not depend on the extractor: the same code aligns Trafilatura's text.
4. **Shadow DOM must be flattened before running any extractor.** `cloneNode(true)` drops shadow roots.
   - Fixtures: product main-text survival goes from 67.6% to 94.1% after flattening.
   - On MDN, 55% of the text sits inside open shadow roots.
5. **Stamp once, in the live page, after it settles.**
   - A DOM-quiet window of 600 ms captured the whole SPA fixtures (40 and 52 elements).
   - Snapshotting right after `load` captured only 10 and 9.
6. **Deterministic.** 12 of 12 fixtures give identical `(id, tag, parent)` sequences across two independent loads.

## How to reproduce

```bash
pnpm install                                     # from the repo root (this folder is a workspace package)
cd experiments/spikes/collect-align
node src/run.mjs --fixtures                      # tables below; no tr-* columns without trafilatura
GP_TRAF_PYTHONPATH=<dir> node src/run.mjs --fixtures --verbose
node src/run.mjs --url <public url> [--url ...]  # output goes to <repo>/data/collect-align/ (gitignored)
node src/run.mjs --fixtures --lint-truth         # checks the truth files only; exits 1 on a gap
```

- `GP_TRAF_PYTHONPATH` is a directory containing the `trafilatura` package, e.g. one created with `pip install --target <dir> trafilatura`.
- `GP_CHROMIUM` overrides the browser binary.
- A full fixture run takes ~90 s, because of the settle waits and the determinism check.

## What was built

| File | Role |
|---|---|
| `src/inpage.js` | Injected with `addInitScript`. Mutation tracking from document start, `stampIds`, `snapshot`, `applyTruth`, `runReadability`, `flattenedHtml` |
| `src/collect.mjs` | Launches the cached Chromium, then load → settle → stamp → snapshot. `pageFlags` marks error, captcha, paywall and tiny pages |
| `src/align.mjs` | Aligns text units to nodes (beam DP plus an order-free rescue) |
| `src/pipeline.mjs`, `metrics.mjs`, `report.mjs`, `run.mjs` | Orchestration, scoring against truth, tables |
| `src/traf_extract.py` | Runs Trafilatura (text output) over the stamped HTML files |

**Id scheme**
- `n<k>`, where k is the pre-order index in the *composed* tree: an element, then the children of its open shadow root, then its light-DOM children.
- Text nodes get no attribute. The snapshot lists them in document order as `texts: [{ id: "<owner>#t<childIndex>", owner, t }]`.
- Ids are valid for one snapshot only.

## Fixtures

`fixtures/pages/` holds 12 hand-written pages, two per category: article, product, docs, forum, landing and SPA. All text is invented.

- **Noise included:** nav, footer, cookie banners, ad slots, sidebars, related links, newsletter boxes, hidden elements (`display:none`, `visibility:hidden`, off-screen), an iframe placeholder, and open shadow-DOM components.
- **SPA pages** render through inline JS in two waves.
- **Truth files:** each page has `<name>.truth.json` with ordered CSS-selector rules. An element takes the label of the nearest ancestor-or-self that matches a rule.

**Labeling convention**
- **main:** title and body of the primary object (product: title, price, description, specs).
- **support:** content that belongs to the page but not to the object (byline, captions, breadcrumbs, reviews, comments, pricing, testimonials).
- **noise:** chrome, ads, related lists, widgets.

## Results (fixtures)

Unit of evaluation: an element that owns non-whitespace text (`<title>` excluded). There are 181 truth-main elements. Ratios are character-weighted and micro-averaged per category.

### (a) Readability `data-gp-id` survival on truth-main elements

| category | pages | main elems | ids kept (plain clone) | ids kept (shadow inlined) | main chars kept | kept by text alignment | id lost |
|---|---|---|---|---|---|---|---|
| article | 2 | 28 | 26 (92.9%) | 26 (92.9%) | 98.6% | 26 | 0 |
| docs | 2 | 67 | 66 (98.5%) | 66 (98.5%) | 98.6% | 66 | 0 |
| forum | 2 | 13 | 11 (84.6%) | 11 (84.6%) | 94.5% | 11 | 0 |
| landing | 2 | 20 | 11 (55.0%) | 11 (55.0%) | 63.5% | 11 | 0 |
| product | 2 | 34 | 23 (67.6%) | 32 (94.1%) | 95.7% | 32 | 0 |
| spa | 2 | 19 | 18 (94.7%) | 18 (94.7%) | 98.3% | 18 | 0 |
| **ALL** | 12 | 181 | 155 (85.6%) | 164 (90.6%) | 94.2% | 164 | 0 |

### (b–d) Precision / recall / F1 (%), positive = main

| category | rd-attr (plain) | rd-attr+shadow | rd-text (DP) | rd-hybrid | tr-text | tr-text+2/3 |
|---|---|---|---|---|---|---|
| article | 94.0/98.6/96.2 | 94.0/98.6/96.2 | 92.8/98.6/95.6 | 92.7/98.6/95.6 | 98.6/97.8/98.2 | 97.6/97.8/97.7 |
| docs | 95.6/98.6/97.1 | 95.6/98.6/97.1 | 95.6/98.6/97.1 | 95.6/98.6/97.1 | 93.4/100/96.6 | 91.6/100/95.6 |
| forum | 89.5/94.5/92.0 | 89.5/94.5/92.0 | 75.0/94.5/83.7 | 75.0/94.5/83.7 | 74.9/61.3/67.4 | 74.9/61.3/67.4 |
| landing | 48.7/63.5/55.1 | 48.7/63.5/55.1 | 48.7/63.5/55.1 | 48.7/63.5/55.1 | 51.8/63.2/56.9 | 51.8/63.2/56.9 |
| product | 50.0/84.0/62.6 | 53.2/95.7/68.4 | 52.5/95.7/67.8 | 52.5/95.7/67.8 | 77.4/33.5/46.7 | 66.3/68.5/67.4 |
| spa | 87.7/98.3/92.7 | 87.7/98.3/92.7 | 86.2/98.3/91.9 | 85.7/98.3/91.6 | 97.6/100/98.8 | 97.6/100/98.8 |
| **ALL** | 80.9/93.0/86.6 | 81.1/94.2/87.2 | 78.6/94.2/85.7 | 78.5/94.2/85.7 | 87.8/83.4/85.5 | 85.3/87.1/86.2 |

With positive = main + support, the ALL row is 94.7/85.2/89.7 for `rd-attr+shadow`, 93.3/86.6/89.8 for `rd-text` and 96.3/76.1/85.0 for `tr-text+2/3`. Restricting to visible elements moves the numbers by less than 2 points.

**Reading the tables**
- **Product and landing are hard for every heuristic extractor.** Readability keeps reviews, related products and FAQs, and misses the purpose of a landing page (F1 ≈ 55%). This is where a learned model can add value, consistent with the published benchmarks.
- **On forums, `rd-text` has lower precision than `rd-attr`.** That is because it correctly sees text-only divs that Readability kept and whose ids were lost; `rd-attr` under-reports what Readability actually kept.
- **`isProbablyReaderable` is a free routing signal.** It is true on all 6 article/docs/SPA fixtures and false on all 6 forum/landing/product fixtures.
- **Trafilatura** is more precise on articles and SPAs (F1 98) but weaker on product and forum pages (recall 33–61%). Its text is sometimes out of document order, so the order-free rescue is needed. It also needs markup normalization (table pipes, list dashes) on both sides of the alignment.

### Settle strategy (SPA fixtures)

Each cell: elements / own-text characters / wait / elements added after stamping.

| page | load only | DOM-quiet 150 ms | DOM-quiet 600 ms | networkidle + quiet 600 ms |
|---|---|---|---|---|
| spa-1 | 10 el / 38 ch / 0 ms (+18 late) | 10 el / 38 ch / 154 ms (+18 late) | 40 el / 1362 ch / 1308 ms | 40 el / 1362 ch / 804 ms |
| spa-2 | 9 el / 30 ch / 0 ms (+33 late) | 9 el / 30 ch / 101 ms (+33 late) | 52 el / 1125 ch / 1407 ms | 52 el / 1125 ch / 905 ms |

A 150 ms quiet window is shorter than the gap between render waves, so it fails exactly like no wait at all.

## Real pages (qualitative)

Outputs are stored only under `data/`. These pages have no truth labels.

| page | elements | text elements | Readability output | readerable | alignment coverage | ids ∩ text agreement |
|---|---|---|---|---|---|---|
| Wikipedia article | 10,540 | 4,825 | 91,192 ch / 3,516 ids | true | 100% | 99.1% |
| MDN API docs page | 1,962 | 615 | 7,059 ch / 357 ids | false | 100% | 89.9% |
| Hacker News thread | 2,260 | 627 | 23,160 ch / 763 ids | true | 100% | 56.9% |
| books.toscrape product | 94 | 29 | 2,513 ch / 43 ids | true | 100% | 100% |
| react.dev learn page | 2,366 | 1,288 | 11,877 ch / 1,372 ids | true | 100% | 91.3% |

- Stamping 10.5k elements took 33 ms. No elements were added late on any page.
- Snapshot time is dominated by `getComputedStyle` and moving ~3 MB of JSON over CDP (2.4 s on the Wikipedia page).
- Shadow DOM is real: MDN has 47 open shadow roots holding 55% of its text. Readability saw 100 ids on a plain clone and 357 after inlining.
- Iframe content is opaque: react.dev has 5 iframes, which are not entered.
- One run hit a "Too many requests" error page. `pageFlags` is meant to catch such pages, but it was not re-tested against that error page.

## Recommendation (E1.4 / E1.5 / E2.6)

**Probe vs vectorize.** Keep the split.
- `probe` does everything that needs the live DOM: stamping, text units in document order, computed style, rects, visibility and page flags.
- `vectorize` reads only the snapshot.
- Before freezing FeatureSchema v0, add to the snapshot: `href` per `<a>`, the `id` and `role` attributes, form-control type, and `og:type` / JSON-LD `@type`.

**Id stamping**
- Stamp once, after settle, in the live page, with the composed-tree pre-order described above.
- The traversal order must be part of the `PageSnapshot` contract. Otherwise the extension and the collector will disagree on ids.

**Settle procedure**
1. `load`.
2. Best-effort `networkidle`, capped at 3 s.
3. DOM-quiet of at least 600 ms, observing the document and every open shadow root from document start, with a hard cap of 8 s.

Record the settle reason and the late-unstamped count in the snapshot.

**Labels**
1. Run each extractor on a clone of the stamped document with open shadow roots inlined.
2. Label = ids found in the extractor's HTML **∪** text→node DP alignment. For text-only extractors such as Trafilatura, use the DP alone, with the order-free fallback.
3. Treat the `<h1>` that matches `<title>` as main, by a deterministic rule. This covers 9 of the 17 fixture misses.
4. Keep alignment coverage on the label record. Below ~90% coverage the extractor rewrote the text, so discard the label or route the page to the LLM.
5. `isProbablyReaderable = false` is a free first signal for routing a page to the LLM.

**Not decided here:** element-level vs text-unit-level labels, closed shadow roots, same-origin iframes, paywall/captcha detection on live pages, and the cost of `getComputedStyle` inside the extension.

## Caveats

- **Small, author-friendly sample.** 12 fixtures and 181 main elements, with one author writing both the pages and the truth rules. That is friendlier to Readability than the real web. These numbers sanity-check the pipeline; they are **not** the product evaluation, and they have no confidence intervals.
- **Spike-only shadow observer.** The in-page `attachShadow` wrapper used to observe shadow roots is fine for a spike, not for the extension.
- **Untested loss mode.** Readability also copies a wrapper's attributes onto its single DIV/SECTION child (`Readability.js` ~545–556), which overwrites the child's `data-gp-id`. This was read from the source and not measured separately.
- **Privacy.** No real page text is committed. Real snapshots live under `data/collect-align/` (gitignored).

## Note 2026-11-25: truth revisions R1-R3 (annotation guide, section 8)

The historical numbers above were computed with the original hand-written truth and are left as they were. Before the pre-registration freeze the annotation guide revised three fixture rules (`fixtures/pages/*.truth.json`): **R1** `article-1` gets `.comments button -> noise` ("Load more comments" is a control, not comment text), **R2** `forum-2` splits `.votes` into `.votes div -> support` (score and "Accepted") and `.votes button -> noise`, **R3** `product-1` keeps `.trust -> noise` but marks `.trust li:nth-child(-n+2)` as support (the 30-day returns and the warranty are concrete facts). `--lint-truth` still passes (every text-bearing element is covered).

Re-running `node src/run.mjs --fixtures` on the revised truth: the numbers with positive = main (sections 1, 2 and 4) do not change, because R1-R3 only move elements between support and noise. Only positive = main + support moves (ALL row, P/R/F1 %): `rd-attr+shadow` 94.7/85.2/89.7 -> **94.9/85.2/89.8**, `rd-text` 93.3/86.6/89.8 -> **93.6/86.7/90.0**, `tr-text+2/3` 96.3/76.1/85.0 -> **96.3/76.0/84.9** (Trafilatura 2.4.0 re-run). The `@gran-prix/labels` fidelity test uses the new main + support constants.
