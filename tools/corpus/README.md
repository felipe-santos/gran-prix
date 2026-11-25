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
  internal use only; its HTML is not redistributed and not stored (the complete 7,809-page file, ~1.35 GB, is only
  streamed and only the URL, track id, language and JSON-LD types are kept). The licence says nothing about the copyright of the source pages.

## Usage

```bash
pnpm install
# the collector reuses the collect stage's own capture code from the built packages:
pnpm --filter @gran-prix/contracts build && pnpm --filter @gran-prix/features build \
  && pnpm --filter @gran-prix/labels build && pnpm --filter @gran-prix/infer-ts build \
  && pnpm --filter @gran-prix/model build && pnpm --filter @gran-prix/report build \
  && pnpm --filter @gran-prix/cli build          # (tsc may report errors in unrelated stages; capture.js is still emitted)

node tools/corpus/src/cli.mjs frame                    # 1. frame.jsonl from the two URL lists (network: ~35 MB of WCXB metadata + ~1.35 GB of WebMainBench streamed, never stored)
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

`tinyld` (MIT, no dependencies, ISO 639-1 output, built for short texts), used as described in "Notas de implementação,
tentativa 2" below. Chosen over `franc`/`franc-min`, which need long texts and confuse close languages (pt/es/gl) more often
on short snippets, and over `cld`/`cld3`, which need native builds.

## Known limits

* The SPA test is an approximation: "visible text in the server HTML" ignores CSS.
* The adult, profile and PII checks are keyword/URL heuristics. The first-20 aid (`first20-exclusions.md`) and the
  accepted-page screenshots exist so the owner can look.
* Category membership is the dataset's label (WCXB) or a URL/JSON-LD rule (WebMainBench). The protocol asks that doubtful
  category cases be settled by URL and screenshot before labelling: the screenshots are in `screens/`.
* The collect stage's flatten step (`tools/cli/src/stages/collect/flatten.ts`, outside the probe) still reads `el.shadowRoot`,
  `host.getAttribute` and `document.*` the plain way: a page whose `<form>` has a control literally named `shadowRoot` (or
  an `<img name="cloneNode">`) could still fail there. Not seen in attempt 2; reported, not fixed (out of the lane's scope).

## Notas de implementação, tentativa 2

The first collection (attempt 1, archived in `attempt-1/` of the data dir) exposed three implementation defects. The
**protocol rules did not change** (§2.2 is frozen): these are corrections of how the rules are implemented, written down before
the second collection started, and no rule changed once it started.

1. **Probe vs DOM clobbering (`packages/features/src/probe/dom.ts`).** A `<form>` with a control named `children` made
   `el.children` the control; the probe threw and the page was excluded as `capture` (yeti.com, sweetwater.com, ...: an
   e-commerce bias). The probe now reads every Element/Node/Document/ShadowRoot property through getters and methods captured
   from the prototypes. Snapshot ids of the 13 fixtures are unchanged; `PROBE_VERSION` stays 0.2.0.
2. **Captcha flag (`tools/cli/src/stages/collect/flags.ts`).** `captcha` used to match anywhere in the rendered text, so documentation
   and shops that mention CAPTCHAs were excluded (supabase docs auth, cloudflare CDN, finewoodworking forum, huel, leverx). It now
   marks a challenge page: the pattern in the `<title>` (anchored phrases of the interstitials), or in a rendered text shorter than
   800 characters (interstitials are ~300-600; 800 leaves headroom over the longest known one and was not tuned on a sample).
3. **Language and keyword heuristics (`src/rules.mjs`).**
   * Language, written before the run: (a) the sample is the visible text units of >= 40 characters concatenated up to 5,000
     characters (all visible text if fewer than 300 remain); (b) L_h is the primary subtag of `<html lang>` when well formed;
     (c) `tinyld.detectAll(sample)`; (d) if L_h is among the detector's top 3, or the detector does not decide, the page's language is
     L_h, else the detector's first choice. The protocol limits are unchanged: en, with pt/es at most 30% per category, any
     other language excluded. Motivation: short technical English (API docs, shop pages) was classified tl, el, cs, hi, rn.
   * Adult: `18+` only with an age context ("18+ only", "adults only", "must be 18", "over 18 to enter"), `xxx` only when it names
     content ("xxx videos", "xxx porn"); the threshold of 3 hits and the host list are unchanged. Motivation: "Java 18+" in the
     Spring Boot tutorial and placeholder `xxx`.
   * Out-of-scope type: the search/login/registration/feed words count only when they are the whole path (optionally under a
     locale prefix), not any path segment (`/docs/guides/auth` is documentation); `?s=` needs a non-numeric value (`?s=20` is a
     Twitter share parameter). Title rule unchanged from the attempt-1 fix.
   * Profile / PII: one-segment URLs of big platforms (`github.com/<x>`) are profiles unless the segment is a reserved product
     word (`features`, `enterprise`, `pricing`, ...); `/people/` and `/members/` alone are sections, not profiles (XenForo
     `/members/name.1234/` still is); e-mail addresses at RFC 2606 / placeholder domains do not count towards the 5-address threshold.
