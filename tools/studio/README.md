# @gran-prix/studio (`gp-studio`)

The human label review interface of the DOM experiment (E2.4). It shows the pages of a `gp` data dir, lets one
person label every text element in 3 classes (**main / support / noise**) plus the flags **doubt** and **mixed**,
mostly with the keyboard, and exports contract-valid `NodeLabels` (`source=human`). Labels follow the annotation
guide (`IDEIAS/plano/guia-de-anotacao.md`, frozen after calibration); the UI only summarizes the guide in a
quick-reference panel and never changes it.

**Privacy: local only.** The server binds to `127.0.0.1`, is protected by a random per-session token, and nothing
leaves the machine: no network calls, no telemetry, no CDN. The captured pages are shown in a sandboxed frame that
cannot run scripts or load anything from the network. Logged-in pages (guide 4.6b) are labeled with this tool only.

## Launch

```bash
pnpm install
pnpm --filter @gran-prix/contracts --filter @gran-prix/labels build   # the server imports their dist
pnpm --filter @gran-prix/studio build                                # tsc (server) + vite build (UI -> dist/ui)

# pages come from a `collect` stage run: gp run <pipeline> --data-dir data
node tools/studio/dist/bin.js --data-dir data --annotator ana
# or, from tools/studio:  pnpm start -- --data-dir ../../data --annotator ana
```

The command prints a URL such as `http://127.0.0.1:4817/?token=...`; open it in a browser. The token is the key
to the session: keep it private (anyone who can see it and reach your loopback interface can read the pages).

| option | meaning |
|---|---|
| `--data-dir <dir>` | gp data dir whose artifact store (`<dir>/artifacts`) holds the SnapshotSet(s) to label. Default `data` |
| `--annotator <name>` | who labels; files go to `<data-dir>/human-labels/<annotator>/`; becomes `labeler.id = human@<name>`. Default: your login name. Letters, digits, `.`, `_`, `-` |
| `--port <n>` | port on 127.0.0.1 (default: a free one) |
| `--default-mode blind\|review` | mode of pages not opened yet. Default `blind`: no draft is ever shown |
| `--guide <file>` | optionally serve the annotation guide as text so the quick-reference can link to it |

The launcher is its own bin (`gp-studio`), not a `gp studio` subcommand: `tools/cli` does not depend on the Studio
(and must not: the Studio reads the same store the cli writes), so wiring one into the other would need a
dependency cycle or a dynamic import of an undeclared package.

## Modes (per page)

* **blind** (the audit, guide section 6): every unit starts unlabeled; the server never sends a draft or extractor
  votes to the UI for a blind page (enforced in the server, not just hidden in the UI).
* **review** (remaining gold, training sample): shows a draft and the reviewer confirms or changes each unit. The draft
  is, in order of preference: a `NodeLabelsSet` artifact of the data dir for that snapshot (LLM > merge > readability/
  heuristic > rule; the Studio's own `human@...` exports are never drafts), else Readability computed on the spot
  (kept = main, dropped = noise). `[M]` marks the draft's proposal, not yet your label; after you label a unit
  that differs, it gets a red outline and a `S≠M` badge ("my S against the draft's M"), and `v` shows only the disagreements.
  Nothing counts until you confirm it (`c`/Enter per unit or subtree, `Shift+C` for everything left, which asks first).

The mode is chosen per page in the list. It is locked once the page holds a label (switching asks to discard them),
so a blind page can never be contaminated by a draft and a review page never mixes protocols.

## What you label (universe U)

The unit is the element with own text, that is **rendered** after the settle, or a **content disclosure** (closed
`<details>`, inactive tab panel: the snapshot's `flags.disclosure`, contracts v1.1; the Studio opens them in the
frame so they can be clicked, and marks them *collapsed*). Hidden, off-screen, `sr-only`, zero-size, `<head>` and
script/style text are outside U and are neither shown as targets nor required. Containers (no own text) can carry a
label too: it is inherited by everything below them until a descendant has its own (nearest-ancestor convention, as in
the fixtures' `truth.json` files and guide 2.2). U size is `labeled / U` in the page list.

## Keyboard (click an outlined element or press `j` first)

| key | action |
|---|---|
| `1` / `2` / `3` | label the selected element **and its subtree**: main / support / noise (then jumps to the next unlabeled unit) |
| `Shift+1/2/3` | label **only** the selected element (children that relied on inheritance keep their label) |
| `d` / `m` | toggle **doubt** / **mixed**. Right after a label key they apply to the unit you just labeled |
| `j` / `k` | next / previous **unlabeled** unit (wraps) |
| `Down` / `Up` | next / previous unit, labeled or not |
| `Left` or `h` / `Right` or `l` | select the parent (grow to a container) / go back down |
| `c` or `Enter` | review mode: accept the draft of the selected unit (or all units of the selected container) |
| `Shift+C` | review mode: accept the draft for every unit still unlabeled (asks first) |
| `x` / `Backspace` | clear the labels of the selected subtree |
| `u` or `Ctrl+Z` / `Shift+U` or `Ctrl+Y` | undo / redo |
| `e` | export this page |
| `v` | review mode: show only disagreements |
| `a` | toggle auto-advance |
| `g` / `?` | guide quick reference / key map |

Mouse: hover highlights the element under the pointer (yellow), click selects it (black frame) and nothing else
happens: links, buttons and forms in the captured page do nothing. (The guide's section 6 describes click = label
subtree; here a click only selects and the keys label, which avoids accidental labels. Same effect, one more key.)

Classes are readable without colour: **main** solid outline, diagonal stripes, badge `M`; **support** dashed outline,
dots, badge `S`; **noise** dotted outline, horizontal lines, badge `N`; **unlabeled** orange double outline. Flags show
as `?` (doubt) and `~` (mixed) on the badge; palette is Okabe-Ito.

## Export

`Export` (or `e`) writes `NodeLabels` for the page and **refuses while any unit of U is unlabeled**: nothing is written
and the unlabeled units are listed (click one to jump to it; `j` walks through them). The document:

* `format: gran-prix.node-labels`, `label_space: multiclass [main, support, noise]`, `source: human`, `confidence: 1`
  on every item, `labeler: { id: "human@<annotator>", kind: "human" }`, items sorted by `unit_id` (= snapshot node idx,
  the `n<k>` id), `coverage: { n_labeled: |U|, n_candidates: |U| }`;
* the flags travel in `reason` (`doubt`, `mixed` or `doubt,mixed`; guide 2.4);
* an open extension block `studio: { mode, guide_version, n_doubt, n_mixed, draft }` records how the labels were made
  (it is part of `labels_id`; re-exporting the same labels gives the same id, no timestamps inside).

"Export all complete pages" in the list exports every page that is complete and reports the others.

## Where files go

```
<data-dir>/human-labels/<annotator>/
  <snapshot hex>.json          working state of a page: explicit labels, flags, mode, draft used (autosaved)
  timelog.jsonl                append-only: {page, mode, start, end, seconds, annotator} per work session
  export/labels/<hex12>.json   exported NodeLabels (a NodeLabelsSet layout: usable as an external input)
```

`<data-dir>/artifacts` is read, never written. `human-labels/` lives under `data/`, which is gitignored (page text
never gets committed).

## Time log

The page header shows active time on the page and in total (also in the list). The clock counts a second only while
the tab is visible and you touched the keyboard or mouse in the last 60 s; each work session is appended to
`timelog.jsonl` when you leave the page, hide the tab or close the window (the server caps `seconds` at the wall-clock
span of the session). Sum it for the human-hours budget of the experiment (`experimento-dom-v0.md` section 5).

## Security model

* `127.0.0.1` only (never `0.0.0.0`); `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding);
  state-changing requests need the `X-Studio-Token` header, a JSON content type and a same-origin `Origin` (CSRF);
  GETs accept the token as `?token=` (first page load, iframe `src`).
* The captured page is served from `/api/pages/<hex>/frame` with `Content-Security-Policy: default-src 'none';
  style-src 'unsafe-inline'; img-src data:; ...; sandbox allow-same-origin` and shown in `<iframe
  sandbox="allow-same-origin">` (no `allow-scripts`): no script runs, nothing is fetched (images of the page do not
  appear: the capture is of the rendered DOM, not of its network resources), and the app draws the overlay by setting attributes on the frame's
  elements. The HTML is never interpolated into the app's DOM.
* Paths from manifests and URLs are checked (no `..`, no absolute, no empty segments); snapshot ids must be 64 hex
  characters; annotator names are restricted to a safe charset.
* The app page has `script-src 'self'`; the specs carry no commands (this tool executes nothing).

## Development

```bash
pnpm --filter @gran-prix/studio test        # unit + server tests + headless smoke (needs Chromium)
pnpm --filter @gran-prix/studio typecheck
```

The tests run against the sibling sources (no prior build of the workspace packages), build the UI bundle once and run
the real `collect` stage over two fixture pages (article-1, product-2) to get a real SnapshotSet. Layout:
`src/core` pure logic shared by server and UI (universe U, label inheritance, keyboard reducer, export plan),
`src/server` node `http` server and stores, `src/ui` React app. Known limits: iframe content of other origins and
closed Shadow DOM are not in the snapshot (guide 3.1); images and external CSS of the captured page are not shown;
the guide link works only when started with `--guide`.
