# @gran-prix/corpus (`gp-corpus`)

Frame builder, sampler/collector and split check of the **pre-registered corpus of experiment dom-v0** (E2.3).
It implements `experimento-dom-v0.md` §2 (corpus), §3 (splits) and §4 (capture) exactly as frozen (tag `prereg-dom-v0`);
nothing in `src/config.mjs` is tunable. A different choice is a registered deviation, never an edit.

**Page content never goes to git (D12).** Everything the tool writes lives in a gitignored data dir (default
`/home/ubuntu/files/PRIX/gran-prix/data/corpus/frame-v0/`, override with `--data-dir`). This package contains code only.

## Attribution (required by the dataset licenses)

* **WCXB**, the Web Content Extraction Benchmark by Murrough Foley, licensed **CC-BY-4.0**
  (<https://huggingface.co/datasets/murrough-foley/web-content-extraction-benchmark>). The frame uses only its URL
  list and page-type metadata (`metadata.json` and the `url` field of each ground-truth file); its HTML and ground
  truth are not used and not stored. Changes made: URLs are re-ordered, filtered and re-categorised for this corpus.
  The WCXB ground truth is never used as gold or as a gate (§2.4).
* **WebMainBench** (OpenDataLab), **Apache-2.0** (<https://huggingface.co/datasets/opendatalab/WebMainBench>): frame and
  internal use only; its HTML is not redistributed and not stored (the 545-sample file is streamed and only the URL,
  language and JSON-LD types are kept). The licence says nothing about the copyright of the source pages.

## Usage

```bash
pnpm install
# the collector reuses the collect stage's own capture code from the built packages:
pnpm --filter @gran-prix/contracts build && pnpm --filter @gran-prix/features build \
  && pnpm --filter @gran-prix/labels build && pnpm --filter @gran-prix/infer-ts build \
  && pnpm --filter @gran-prix/model build && pnpm --filter @gran-prix/report build \
  && pnpm --filter @gran-prix/cli build          # (tsc may report errors in unrelated stages; capture.js is still emitted)

node tools/corpus/src/cli.mjs frame                    # 1. frame.jsonl from the two URL lists (network, ~145 MB streamed)
node tools/corpus/src/cli.mjs walk                     # 2. walk + collect, resumable (skips every URL in walked.jsonl)
node tools/corpus/src/cli.mjs walk --category docs --limit 10     # a partial run
node tools/corpus/src/cli.mjs report                   # 3. exclusions.jsonl, urls.csv, summary.json, first20-exclusions.md
node tools/corpus/src/cli.mjs split                    # 4. first salt gp-dom-v0-s{i} that satisfies §3 (counts only)
pnpm --filter @gran-prix/corpus test
```

Outputs in the data dir: `frame.jsonl` (`url, source_dataset, source_type, category, order_hash`, plus `source_id`,
`spa_flag`, `domain`), `frame-stats.json`, `walked.jsonl` (every candidate visited, with its outcome and the evidence),
`exclusions.jsonl` (`url, reason`, plus category and the other failing reasons), `urls.csv` (`url,stratum,group_key`, for
`gp run`), `snapshot-set/` (the accepted pages in the exact `SnapshotSet` layout of the collect stage),
`screens/` (one 1366x900 JPEG per page that was loaded in the browser), `summary.json`, `first20-exclusions.md`,
`split-check.txt`, `walk.log`, `raw/` (the dataset URL indexes and licences).

## What it does

1. **Frame (§2.3.1).** WCXB types map `article->article`, `product->product`, `documentation->docs`, `forum->forum`,
   `service->landing`; pages flagged `spa` go to `spa`; `listing` and `collection` never enter (a SPA-flagged listing is
   dropped too). WebMainBench only adds URLs WCXB lacks, classified by JSON-LD `@type` and then URL path rules
   (`classifyWmb`); the rest stays out. Each row gets `order_hash = sha256("gp-dom-v0|20261125|" + url)`.
2. **Walk (§2.3.2).** Categories are walked in table order (article, product, docs, forum, landing, spa), each in ascending
   `order_hash`; a rejected candidate is replaced by the next one, no human choice. A category stops at its target n
   (30/30/30/30/25/25).
3. **Rules (§2.2), by script, in `src/rules.mjs`.** HTTP 200 final; page flags `http-error`/`error-page`/`captcha`/
   `paywall` from the collect stage (`capture.extra.flags`); >= 300 visible characters after settle; language
   `en`, `pt` or `es` (per category at most floor(30% of n) pages in pt/es); at most 1 page per (eTLD+1, category) and
   2 per eTLD+1 (PSL with the private section, via `tldts`, like the CLI); `robots.txt` allows the path; <= 5,000 elements
   with own text; out-of-scope type (search/login/index URL or title shapes), adult content and personal profile / evident
   PII heuristics. Each exclusion records the first failing reason and the others in `also`.
4. **SPA (§2.1, §2.3.5).** A `spa` candidate must have < 200 visible characters in the server HTML (fetched without
   JavaScript, scripts/styles/`<noscript>` stripped) and > 1,000 after hydration. The 12 WCXB-flagged pages are walked
   first; when the frame is exhausted the walk continues (phase `spa-fallback`) over the other frame URLs that are not
   already in the corpus, same hash order, and the rendering rule decides.
5. **Capture (§4).** The accepted pages are captured with `capturePage` of the built `@gran-prix/cli` (the collect
   stage's own code), so each snapshot is the pipeline's format: Chromium 1254 headless, 1366x900, `en-US`,
   load -> networkidle (cap 3 s) -> DOM quiet >= 600 ms (cap 8 s), `data-gp-id` stamped. One page at a time, a fresh browser
   context per page.
6. **Politeness.** User agent `WebContentResearchCrawler/1.0 (non-commercial research crawler; honors robots.txt; ...)`
   for the browser and for plain requests (no personal or project identifiers, no contact address); one request at a
   time per host with >= 1.5 s between requests; navigation timeout 30 s, hard cap 110 s per page; no logins, no cookies shared
   between pages; `robots.txt` per origin per RFC 9309 (a 5xx or unreachable robots.txt counts as complete disallow, reason
   `robots-unavailable`).

## Language detection

`tinyld` (MIT, no dependencies, ISO 639-1 output, built for short texts). Chosen over `franc`/`franc-min`, which need
long texts and confuse close languages (pt/es/gl) more often on short snippets, and over `cld`/`cld3`, which need native
builds. The detector runs on the first 3,000 characters of visible text; `<html lang>` is recorded but not used.

## Known limits

* The SPA test is an approximation: "visible text in the server HTML" ignores CSS.
* The adult, profile and PII checks are keyword/URL heuristics. The first-20 aid (`first20-exclusions.md`) and the
  accepted-page screenshots exist so the owner can look.
* Category membership is the dataset's label (WCXB) or a URL/JSON-LD rule (WebMainBench). The protocol asks that doubtful
  category cases be settled by URL and screenshot before labelling: the screenshots are in `screens/`.
* The collect stage's probe breaks on pages whose `<form>` holds a control named `children` (DOM clobbering: `el.children`
  is then not iterable, `packages/features/src/probe/settle.ts:68` and `probe.ts:91`). Such pages are excluded with reason
  `capture`; they are listed in `walked.jsonl`. Fix upstream and re-walk the affected categories if the bias matters.
