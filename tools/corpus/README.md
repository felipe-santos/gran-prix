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
* The flatten step and the driver read the document through prototype getters captured when the expression runs, that is after the
  page's scripts: a page that rewrites `Element.prototype` itself (not just names a form control) could still confuse them.
  The probe is stricter: its accessors are captured at document start, before any page script.

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
4. **Flatten step and driver (`tools/cli/src/stages/collect/flatten.ts`, `packages/features/src/node/driver.ts`; attempt 2b).**
   The first fixes left two collector defects outside the probe. (a) The flatten expression emptied scripts with
   `script.textContent = ""`, a Trusted Types sink: a page with `require-trusted-types-for 'script'` failed as `capture`
   (popmalt.com). Scripts are now emptied by removing their child nodes. (b) It also read `el.shadowRoot`, `host.getAttribute` and
   `document.cloneNode/querySelector` the plain way, and the driver read `document.documentElement.outerHTML` (an
   `<img name="documentElement">` returned the image): all go through prototype getters now. A minimal copy of `probe/dom.ts` is
   inlined in the expression because it runs in a separate `evaluate` and cannot share the bundle's closure. The snapshot ids,
   flattened html and `outerHTML` of the 13 fixtures are identical before and after.
   **Re-evaluation (`gp-corpus revisit`).** Only the candidates excluded as `capture` with an error message from these defects were
   re-evaluated (transient errors such as `Execution context was destroyed` and navigation timeouts are not: their rule is the
   single retry that already exists), with the same rules and the same state. The new record supersedes the old one
   (`supersedes: <seq>`; every output reads the latest record per category and URL). In a complete category a passing candidate would
   take its hash position and push out the last accepted page; that case is not implemented and aborts, because it did not occur:
   the only candidate was `popmalt.com/forums/t/...` (SPA, below its target), which passed and was added (`attempt-diff.md`, 2b).

## Freezing and checking the corpus

* `gp-corpus lock` writes `corpus-v0.lock.json` in the data dir: time, code commit, probe version, the seed and prefix, the sha256 of
  `frame.jsonl`, `walked.jsonl`, `exclusions.jsonl`, `urls.csv` and `snapshot-set/manifest.json`, the counts and the domain list per
  category. It prints the sha256 of the lock itself. The lock is not committed (the data dir is ignored); publish its hash.
* `gp-corpus verify-lock` recomputes everything and exits 1 when anything changed or a snapshot file is missing.
* `gp-corpus review-page` writes `review.html` (static, no external resource, screenshots by relative path) with the accepted pages by
  category, the first 20 exclusions and the exclusions decided by a heuristic rule; answers are kept in `localStorage` and exported as JSON.
  Open it in a browser (VS Code's "Open with Live Server"/Simple Browser also works); it only collects a verdict, it decides nothing.
  Section A shows the requested and the final URL side by side, a **seal** "URL final != pedida" when the host or the path changed
  (host without `www.`, path without the trailing `/`; scheme, query and fragment ignored) and **hints** (not decisions) when the final URL
  looks like an error (`404`, `not-found`, `error`), the home page (path `/` when the request was not), a login/OAuth (`login`, `signin`,
  `oauth`, `authorize`, `/password`), a challenge (`challenge`, `captcha`, `anubis`, `cf_chl`) or another site (eTLD+1 changed). A token
  already present in the requested URL is not a hint (the hint is about where the navigation went). Each page has an answer
  (empty at first: `sim`, `nao` or `duvida`; the summary shows how many are missing), a reason (categoria errada / erro ou soft-404 / login / desafio / home ou listagem / outro + text)
  and a note; the summary counts seals and hints and a checkbox shows only the sealed pages. **Doubt counts as exclusion** (§2.1).
  The export (`gran-prix.corpus-review/1`) has, per page, `snapshot_id`, `url`, `category`, `answer`, `reason`, `reason_text`, `note`, plus
  the sha256 of the lock in force; answers on exclusions (sections B and C) go in `exclusion_checks` and are never applied.

## Applying the owner's review: `gp-corpus apply-review <export.json>`

```bash
gp-corpus apply-review corpus-v0-review-answers.json --check   # validates and prints the plan; writes nothing
gp-corpus apply-review corpus-v0-review-answers.json --allow-partial   # lets pages without an answer through (recorded)
gp-corpus apply-review corpus-v0-review-answers.json           # applies it
```

By rule, never by choice: (1) the export is validated (its lock is the one in force and the corpus still matches it, every page is an
accepted page of the corpus with its snapshot id, no duplicates, known answers/reasons, and **every accepted page has an answer**: an export with
unanswered or missing pages is refused with the list, unless `--allow-partial`, which keeps those pages and is recorded in the lock
(`review_allow_partial`, `review_unanswered`) and in `review-applied.md`); (2) each `nao`/`duvida` page gets a record that
supersedes the accepted one (`outcome: excluded`, `reason: owner-review:<motivo>`, `supersedes: <seq>`, the review attached), so
`walked.jsonl` stays append-only and the trail is kept; (3) the walk of §2.3.2 is **replayed** (`src/replay.mjs`): per category (table order) and phase, in `order_hash`
order, the owner's exclusion as one more criterion, so the result is what would have come out if the review had existed during the walk, whatever
the path. Evaluations already recorded that do not depend on the state (http, robots, page language, flags, chars, capture, type, SPA rule) are
reused; what depends on it (the (domain, category) and domain quotas, the pt/es cap, the SPA fallback pool) is recomputed with the accepted set of
the replay. A candidate that was only barred by a quota that is free now is fetched now, in its position, with the same code (`Collector`), user
agent and rules (the quota is checked before loading, so it never was), and its record supersedes the old one; a page accepted before whose slot a
reopened candidate took is superseded by an exclusion record (no fetch); only after the recorded candidates does the walk go on to never-visited ones,
until the category is complete or the frame is exhausted (SPA: the §2.3.5 fallback may end below the target; it only loses pages and `review-applied.md`
says so); (4) `urls.csv`, `exclusions.jsonl`, `summary.json`,
`first20-exclusions.md`, the snapshot-set manifest and `split-check.txt` are rewritten (the split check keeps the pre-registered rule and the
amended SPA rule), `review-applied.md` lists what left, what entered, the category and the reason, and `corpus-v0.1.lock.json` is written
with `supersedes` (sha256 of the lock it replaces) and `review_export_sha256`.

Interpretations (documented in `review-applied.md` too):

* **Domain quota.** §2.2 limits the pages *included*; a page the owner excluded is no longer in the corpus, so its (domain, category) and
  per-domain slots are free for every candidate the replay evaluates after it, including candidates that were barred by that quota before
  (they are reopened and fetched). The pt/es cap is recomputed the same way. `review-applied.md` gives the reason of every entry and exit.
* **Doubt** = exclusion (§2.1: ambiguous pages are excluded and recorded).
* **SPA.** The fallback pool is recomputed by the replay (the other frame URLs not in the corpus, in hash order); URLs excluded by the owner are
  never candidates again (any category, any phase). With the frame exhausted the SPA category just loses pages.
* **Old lock.** `corpus-v0.lock.json` is not deleted or edited. The files `apply-review` rewrites are first copied to `archive/corpus-v0/`, so
  `verify-lock --lock corpus-v0.lock.json` still passes (it reads the archive); plain `verify-lock` checks the latest lock.
* **Idempotent and resumable.** The same export a second time prints `already-applied` and changes nothing; a run that dies after writing the
  exclusions is finished by running the same command again.
* **Salt.** With the new counts the first valid `i` may change; both readings of the rule are in `split-check.txt` and `review-applied.md`.
  The pipeline's salt is updated by the coordinator.

