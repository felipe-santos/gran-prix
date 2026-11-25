# @gran-prix/features

E1.4. Two layers, kept apart on purpose:

* **`probe`** runs in the *live* page (computed style, layout, shadow DOM) and returns the raw material of a
  `PageSnapshot`: a pre-order element table, text units and page signals.
* **`vectorize(snapshot, schema) -> NodeFeatures`** is a **pure** function of a snapshot and a FeatureSchema.
  No `Date`, no randomness, no DOM, no I/O; every float goes through `Math.fround`. The same source runs in
  Node and inside Chromium and gives **bit-identical** `Float32Array`s (tested on all 12 fixtures).

Features are derived from the stored snapshot, so changing the schema never needs a re-crawl.

```
pnpm install                                     # repo root (pnpm workspace)
pnpm --filter @gran-prix/features test           # builds the IIFE bundle itself; needs a cached Chromium
pnpm --filter @gran-prix/features typecheck
pnpm --filter @gran-prix/features build          # dist/gp-features.iife.js + tsc emit (build @gran-prix/contracts first)
pnpm --filter @gran-prix/features schema:regen   # rewrite src/schema/feature-schema.v0.json from the registry
```

The tests find Chromium through `GP_CHROMIUM` or the newest `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`.
They import `@gran-prix/contracts` from source (vitest alias), so no prior contracts build is needed.

## Layout

| Path | What |
|---|---|
| `src/vectorize/` | The pure part. Compiled by `tsconfig.pure.json` with **no DOM and no Node types**; a test also greps it for `Date`, `Math.random`, `document`, `process`... |
| `src/vectorize/features.ts` | **The registry**: every feature's name, kind, doc, static transform, range, default and raw computation. |
| `src/schema/feature-schema.v0.json` | The committed FeatureSchema, generated from the registry; a test fails on drift. |
| `src/probe/` | In-page code (DOM): composed walk, settle, capture, page signals. |
| `src/browser.ts` | Entry of the IIFE bundle; installs `window.__gpFeatures`. |
| `src/node/` | Node side: Playwright driver and `buildPageSnapshot` (hashes the snapshot with the contracts' identity helper). |

## Id scheme (composed pre-order)

The traversal order is part of the contract between collector, extension and labelers. Ids are valid for **one snapshot**.

```
visit(element)
  -> children of its OPEN shadow root, in order
  -> its light-DOM children, in order
```

* Element id = pre-order index `k`: DOM attribute `data-gp-id="n<k>"` and `nodes[k]` (`idx === k`).
* The parent of a node inside a shadow root is the shadow host.
* A **text unit** is a non-blank light-DOM text node: id `"<owner id>#t<child index among the owner's childNodes>"`, e.g. `n9#t2`.
  `text_units` lists them interleaved in document order. `script`, `style`, `noscript`, `template` text is not content.
* **Not entered**: iframe documents (the `<iframe>` element itself is stamped), closed shadow roots, `<template>` content,
  text nodes sitting directly in a shadow root.

## Settle strategy

1. `load` (driver: `page.goto`, `waitUntil: "load"`).
2. Best-effort `networkidle`, capped at 3 s (driver; chatty pages never idle, the DOM-quiet check decides).
3. **DOM-quiet** (in the page): no `childList` / `characterData` mutation on the document or on any open shadow root for
   >= 600 ms with `readyState === "complete"`; hard cap 8 s from the call. A 150 ms window is shorter than the gap between
   SPA render waves and fails exactly like not waiting (spike FINDINGS).

The record (`reason: "quiet" | "max" | "skipped"`, `waited_ms`, `mutations`, `shadow_roots`, `tracked_from_start`,
`late_unstamped`) goes to `capture.settle`, **outside** the snapshot id. `late_unstamped` is the number of elements that
appeared 250 ms after stamping and therefore have no id.

**Shadow roots without patching `attachShadow`.** The spike wrapped `Element.prototype.attachShadow`. That is
detectable by pages and, in an extension content script (isolated world), would never see the page's own calls. Instead every
open shadow root found by a composed walk is observed; the walk repeats whenever the document mutated and at least every
400 ms. A root attached to an element already in the document is found by the next walk (and counts as activity);
a root attached before insertion is found when the host is inserted. Closed roots are invisible by design. Tested in
`test/probe.test.ts` ("observes open shadow roots attached AFTER insertion").

## Probe output and PageSnapshot

`probe()` returns `{ page, doc, nodes, text_units, probe, settle }`. `buildPageSnapshot(raw, opts)` adds `format`,
`snapshot_id` (the contracts' `contractId("page-snapshot")`), `url_key`, `group_key`, `category`, the `html` file reference and
`capture`. `nodes[i]` is a contract `SnapNode`: whitelisted attrs (`id`, `class`, `role`, `href`, `type`, `aria-label`,
`itemprop`, `alt`, `src`, `name`, each length-capped; `type` of a form control is the implicit default, e.g. `submit`),
`own_text` (whitespace collapsed, first 1000 chars) with `own_text_len` measured before truncation, `text_len`,
`link_text_len`, computed style, page-coordinate rect (`null` when the element has no box) and flags.
Text is made well-formed UTF-16 (lone surrogates become U+FFFD) so the content id can be hashed.

Extensions beyond the contract (its schemas are open): `page.og_type`, `page.jsonld_types`, top-level `text_units`,
top-level `probe` (`id_scheme`, `version`, `own_text_cap`), `capture.settle`.

## How to bundle and inject

```
node scripts/build.mjs         # esbuild -> dist/gp-features.iife.js (self-contained IIFE, ~45 KB, not minified)
```

```ts
import { launch, probeLoadedPage, buildPageSnapshot, vectorize, featureSchemaV0 } from "@gran-prix/features";

const { browser, context } = await launch();          // addInitScript(bundle): tracking starts at document start
const page = await context.newPage();
await page.goto(url, { waitUntil: "load" });
const { raw, html } = await probeLoadedPage(page);     // networkidle (<= 3 s) + DOM-quiet probe in the page
const snapshot = buildPageSnapshot(raw, { category: "article", html: /* FileRef of the stored html */, capture: { /* ... */ } });
const features = vectorize(snapshot, featureSchemaV0);  // NodeFeatures, validates against the contracts
```

Without the driver: `context.addInitScript({ path: "dist/gp-features.iife.js" })` (best: mutation tracking sees the whole load),
`page.evaluate(bundleSource)` (late injection works; `tracked_from_start` is then `false` and the quiet window is
measured from injection), or list the file as an extension content script. Then `await window.__gpFeatures.probe()` and
`window.__gpFeatures.vectorize(snapshot, schema)` (the same function the Node side imports).

## vectorize

1. **Prefilter** (schema `prefilter.rules`): tag rule `skip_tags` (`script style noscript template head meta link base title`) and
   style rule `display_none` (applies to the node **and its whole subtree**, which is not rendered). Prefiltered nodes are not rows
   and are not counted among siblings; their counts are reported in `prefiltered`.
2. **Raw value** per feature (registry); `null` means "does not apply" and yields the schema `default`.
3. **Static transform** of the schema: `none`; `log1p` = `log1p(x) / log1p(scale)`; `clip` to `[lo, hi]`; `div` by `by`.
4. **Sanitize**: `NaN` becomes 0 (`sanitized.nan_replaced`); values outside the feature's `range` are clipped
   (`sanitized.clipped`, the OOD counter); then `Math.fround` (and `-0` becomes `0`).
5. **Context features** copy the finished value of a source feature at the parent / previous / next non-prefiltered sibling
   (extension field `context: { rel, source }` in the schema); the default (0) when that node does not exist.
6. `features_id` is the content id of the document, computed with an in-bundle SHA-256 + RFC 8785 canonicalization that the tests pin to the contracts'.

Normalization is **not** fitted here (that is the dataset / train stage); `range` gives the clip bounds.

Notes on some features:
*stopwords* are a small multilingual function-word list over `own_text` (not language detection);
`own_text` is truncated at 1000 chars, so ratios are computed on the sample and `ends_with_punct` is `0.5` when the text was truncated;
*font size relative* uses the median font size of the visible text-bearing nodes of the page;
*visible* = non-empty box on the canvas, `visibility: visible`, no `opacity: 0` ancestor-or-self.
*Hints* tokenize `id` + `class` (camelCase and non-alphanumeric split, lowercase, tokens of fewer than 2 chars or only digits dropped) and
match exact or prefix lists (`hint_ad`: `ad ads advert* sponsor* promo*`, **not** `advanced`); they are 1 when the node **or an ancestor** matches.
*Hash buckets* are FNV-1a 32 of each token of the node's own `id`/`class`, modulo 4 (presence).

## FeatureSchema v0

`schema_id = sha256:22b5e302ae50bb12c8e2ca4e50f96066791e5c1cb30f1a4c4eb9b265deb179e2`, 59 features. Source of truth: `src/vectorize/features.ts`; file: `src/schema/feature-schema.v0.json`.

| # | name | group | kind | transform | range | meaning |
|---|---|---|---|---|---|---|
| 0 | `log_own_len` | text | scalar | log1p/5000 | [0,1] | log1p(own_text_len) / log1p(5000): characters of the node's direct text. |
| 1 | `log_text_len` | text | scalar | log1p/100000 | [0,1] | log1p(text_len) / log1p(100000): characters of the whole subtree text. |
| 2 | `own_text_ratio` | text | scalar | none | [0,1] | own_text_len / text_len: share of the subtree text that is the node's own. |
| 3 | `link_density` | text | scalar | none | [0,1] | link_text_len / text_len: share of the subtree text inside <a> (Kohlschuetter, CETD). |
| 4 | `text_density` | text | scalar | log1p/1000 | [0,1] | CETD text density: log1p(text_len / elements in subtree) / log1p(1000). |
| 5 | `stopword_ratio` | text | scalar | none | [0,1] | Stopword-like words / words in the node's own text (cheap multilingual list, jusText style). |
| 6 | `punct_ratio` | text | scalar | none | [0,1] | Punctuation characters / characters in the node's own text. |
| 7 | `ends_with_punct` | text | scalar | none | [0,1] | 1 when the own text ends with sentence punctuation, 0 when not, 0.5 when the probe truncated it. |
| 8 | `text_share` | text | scalar | none | [0,1] | text_len / text_len of the root: the node's share of all text on the page. |
| 9 | `depth` | structure | scalar | div 32 | [0,2] | Composed-tree depth / 32 (root = 0). |
| 10 | `log_sibling_count` | structure | scalar | log1p/100 | [0,1] | log1p(non-prefiltered siblings, self included) / log1p(100). |
| 11 | `sibling_index_rel` | structure | scalar | none | [0,1] | Rank among the siblings / (siblings - 1); 0 for an only child. |
| 12 | `sibling_same_tag_ratio` | structure | scalar | none | [0,1] | Fraction of the other siblings with the same tag (high for repeated cards / list items). |
| 13 | `log_subtree_size` | structure | scalar | log1p/5000 | [0,1] | log1p(elements in the subtree, self included) / log1p(5000). |
| 14 | `in_link` | structure | bool | none | [0,1] | 1 when the node is an <a> or inside one. |
| 15 | `doc_pos_rel` | structure | scalar | none | [0,1] | Node index / (node count - 1): relative position in document order. |
| 16 | `tag_p` | tag | onehot | none | [0,1] | 1 for <p>. |
| 17 | `tag_div` | tag | onehot | none | [0,1] | 1 for <div>. |
| 18 | `tag_span` | tag | onehot | none | [0,1] | 1 for <span>. |
| 19 | `tag_a` | tag | onehot | none | [0,1] | 1 for <a>. |
| 20 | `tag_li` | tag | onehot | none | [0,1] | 1 for <li>. |
| 21 | `tag_heading` | tag | onehot | none | [0,1] | 1 for <h1> to <h6>. |
| 22 | `tag_other` | tag | onehot | none | [0,1] | 1 for every other tag. |
| 23 | `in_main` | landmark | bool | none | [0,1] | 1 inside <main> or role=main (self or ancestor). |
| 24 | `in_nav` | landmark | bool | none | [0,1] | 1 inside <nav> or role=navigation. |
| 25 | `in_header` | landmark | bool | none | [0,1] | 1 inside <header> or role=banner. |
| 26 | `in_footer` | landmark | bool | none | [0,1] | 1 inside <footer> or role=contentinfo. |
| 27 | `in_aside` | landmark | bool | none | [0,1] | 1 inside <aside> or role=complementary. |
| 28 | `visible` | geometry | bool | none | [0,1] | 1 when the node has a non-empty box on the canvas, visibility:visible and no opacity:0 ancestor-or-self. |
| 29 | `area_frac` | geometry | scalar | clip[0,1] | [0,1] | Box area / (scroll_w * scroll_h), clipped to [0, 1]; 0 without a box. |
| 30 | `y_center_rel` | geometry | scalar | clip[0,1] | [0,1] | Vertical centre of the box / scroll_h, clipped to [0, 1]; 0 without a box. |
| 31 | `font_size_rel` | geometry | scalar | clip[0,4] | [0,4] | font_size / median font size of the visible text nodes of the page, clipped to [0, 4]. |
| 32 | `font_weight_rel` | geometry | scalar | div 900 | [0,1.25] | font_weight / 900. |
| 33 | `pos_fixed_sticky` | geometry | bool | none | [0,1] | 1 when computed position is fixed or sticky (headers, banners, modals). |
| 34 | `hint_nav` | hint | bool | none | [0,1] | 1 when an id/class token of this node or of an ancestor matches the "nav" hint list (see README). |
| 35 | `hint_footer` | hint | bool | none | [0,1] | 1 when an id/class token of this node or of an ancestor matches the "footer" hint list (see README). |
| 36 | `hint_ad` | hint | bool | none | [0,1] | 1 when an id/class token of this node or of an ancestor matches the "ad" hint list (see README). |
| 37 | `hint_comment` | hint | bool | none | [0,1] | 1 when an id/class token of this node or of an ancestor matches the "comment" hint list (see README). |
| 38 | `hint_related` | hint | bool | none | [0,1] | 1 when an id/class token of this node or of an ancestor matches the "related" hint list (see README). |
| 39 | `hint_cookie` | hint | bool | none | [0,1] | 1 when an id/class token of this node or of an ancestor matches the "cookie" hint list (see README). |
| 40 | `hint_sidebar` | hint | bool | none | [0,1] | 1 when an id/class token of this node or of an ancestor matches the "sidebar" hint list (see README). |
| 41 | `hint_menu` | hint | bool | none | [0,1] | 1 when an id/class token of this node or of an ancestor matches the "menu" hint list (see README). |
| 42 | `hint_share` | hint | bool | none | [0,1] | 1 when an id/class token of this node or of an ancestor matches the "share" hint list (see README). |
| 43 | `idclass_hash_0` | hash | hash_bucket | none | [0,1] | 1 when some id/class token of this node alone hashes (FNV-1a 32) to bucket 0 of 4. |
| 44 | `idclass_hash_1` | hash | hash_bucket | none | [0,1] | 1 when some id/class token of this node alone hashes (FNV-1a 32) to bucket 1 of 4. |
| 45 | `idclass_hash_2` | hash | hash_bucket | none | [0,1] | 1 when some id/class token of this node alone hashes (FNV-1a 32) to bucket 2 of 4. |
| 46 | `idclass_hash_3` | hash | hash_bucket | none | [0,1] | 1 when some id/class token of this node alone hashes (FNV-1a 32) to bucket 3 of 4. |
| 47 | `page_article` | page | bool | none | [0,1] | 1 when og:type is article or JSON-LD @type is an Article kind. |
| 48 | `page_product` | page | bool | none | [0,1] | 1 when og:type is product* or JSON-LD @type is Product / Offer. |
| 49 | `page_discussion` | page | bool | none | [0,1] | 1 when JSON-LD @type is DiscussionForumPosting / QAPage / Question. |
| 50 | `parent_log_text_len` | context | scalar | none | [0,1] | log_text_len of the parent (0 for the root). |
| 51 | `parent_link_density` | context | scalar | none | [0,1] | link_density of the parent. |
| 52 | `parent_text_density` | context | scalar | none | [0,1] | text_density of the parent. |
| 53 | `prev_log_text_len` | context | scalar | none | [0,1] | log_text_len of the previous non-prefiltered sibling (0 when none). |
| 54 | `prev_link_density` | context | scalar | none | [0,1] | link_density of the previous sibling. |
| 55 | `prev_text_density` | context | scalar | none | [0,1] | text_density of the previous sibling. |
| 56 | `next_log_text_len` | context | scalar | none | [0,1] | log_text_len of the next non-prefiltered sibling (0 when none). |
| 57 | `next_link_density` | context | scalar | none | [0,1] | link_density of the next sibling. |
| 58 | `next_text_density` | context | scalar | none | [0,1] | text_density of the next sibling. |

## Tests

* `test/schema.test.ts`: contract validation, 40-60 features, drift against the registry, family coverage, README lists every feature.
* `test/vectorize.test.ts`: hand-built snapshot, prefilter, context, ranges, pure helpers vs the contracts, purity grep.
* `test/probe.test.ts`: id scheme, shadow DOM, captured fields, settle, late injection.
* `test/fixtures.e2e.test.ts`: the 12 fixtures: contract validity, load-to-load determinism, **Node <-> Chromium bit parity**, sanity table.

## Limitations

* Closed shadow roots and iframe documents are opaque; text directly under a shadow root is not a text unit.
* `getComputedStyle` and layout are read per element; the cost inside an extension is not measured here.
* The stopword and sentence-end handling is English-centric; `hint_*` lists are English plus a few common words of other languages.
* `og_type` and JSON-LD are read from the light DOM of the document only.
