# @gran-prix/markdown

The text of a page for the token-reduction measure (experiment DOM v0, protocol section 10, E3.5; gates G4 and the QA arms of
E3.4): **D1** (rendered HTML), **D2** (full-page markdown), the **pruned markdown** of a keep set, and the **cl100k_base**
token counter. Deterministic, offline, versions pinned. The stage that uses it is `ts:measure.tokens@1.0.0`
(`tools/cli/src/stages/tokens/`).

The converters and the tokenizer are frozen before any result (protocol 13). A change that can alter an output bumps
`CONVERTER_VERSION` (`src/versions.ts`), which is part of the stage's cache key.

## Pinned dependencies

| package | version | license |
|---|---|---|
| `turndown` | 7.2.5 | MIT |
| `turndown-plugin-gfm` | 1.0.2 | MIT |
| `js-tiktoken` (`lite` + `ranks/cl100k_base`) | 1.0.21 | MIT |
| `jsdom` | 27.4.0 (the version `@gran-prix/labels` already uses) | MIT |
| `@types/turndown` (dev) | 5.0.6 | MIT |

`js-tiktoken` is pure JS and ships the ranks, so no download and no network. `jsdom` runs without `runScripts` and without
`resources`: nothing in the stored page is executed or fetched.

## D1

`documentElement.outerHTML` of the rendered, settled DOM, without `data-gp-*`, inline `<script>` and `<style>` included
(`d1Html`). It comes from the snapshot's `html.gz`, which is NOT exactly that string; the differences, decided here:

| what the stored html does | effect on D1 | decision |
|---|---|---|
| carries `data-gp-id` on every element | would add tokens | removed (a scanner over the serialization: every other byte is untouched; text, comments and raw-text elements are left alone) |
| `<script>` elements are **emptied** by the collector (the page's code is not stored) | D1 undercounts inline scripts | kept as is, documented: **D1 is a lower bound** for scripts, so the D1 ratio is conservative. `notes.script_elements` says how many were emptied |
| open shadow roots are **inlined** (a real `outerHTML` drops them) | D1 counts shadow content that `outerHTML` would not | kept (the content is on screen, and the ids need it); `notes.shadow_nodes` says how many nodes. This makes D1 larger on such pages |
| `<!DOCTYPE>` prefix | 15 tokens | removed: D1 is `documentElement.outerHTML` |

Nothing recovers the original script bytes without a re-collection. If the owner wants an exact D1, the collector would have
to store the script sizes (a contract question, see the lane report).

## D2

`turndown` + GFM plugin, turndown's default options with `headingStyle: "atx"` (`TURNDOWN_OPTIONS`), over a jsdom DOM of the
stored html. Removed: `script style noscript template svg`, the non-content tags (`head title meta link base`) and
**unrendered elements**. Every `<img>` becomes `![alt]()` (no URL, no data URI; a decorative image is `![]()`). Links keep their
`href`. Two behaviours come from the plugin, not from us: a `<table>` whose first row is not a heading row stays as raw HTML
(`data-gp-*` is stripped from it), and strikethrough is `~x~`.

### "Rendered": one definition

`isRenderedNode` (`src/rendered.ts`) is the rule that decides membership in the universe U (guide 2.3): not `display:none`,
not `visibility:hidden|collapse`, effective opacity (own x ancestors') above 0, laid out (`rect` not null), a real box (not the
1x1 clip of `.sr-only`, not zero-sized), not pushed off the left or top. It is the rule of `tools/studio/src/core/universe.ts`
(`computeUniverse`), extracted as a pure function. The Studio still holds its own copy; the test
`'rendered' is the rule of U` (`tools/cli/test/tokens-stage.test.ts`) checks, for every unit of the 13 fixtures, that the
converter keeps a unit's text iff `computeUniverse` says so. **Proposal:** make `universe.ts` import `isRenderedNode` and
`NON_CONTENT_TAGS` from this package (one-line change in a package outside this lane); the test then becomes a tautology
and can be dropped.

How the rule applies to markup (`planPage`, pure, from the node table alone):

- `display:none`, effective opacity 0, a non-content tag, and an unrendered `<img>` (hidden, a 1x1 pixel) drop the element **with its subtree**
  (these propagate to descendants in U as well: `rect` is null below `display:none`).
- Every other rule (visibility, the clip, off-screen, no box) applies to the element's **own text** only: the text goes, the
  structure stays if something rendered lives below it (a visible child of a `visibility:hidden` parent), else the element goes too.
- `rect === null` alone does not drop a subtree: `display:contents` has no rect and its children are on screen.

### Collapsed content (decision, constant `COLLAPSED_CONTENT_IN_D2 = "exclude"`)

The snapshot marks content inside a closed `<details>`, an inactive tabpanel or an accordion panel with `flags.disclosure`:
not rendered, but part of U. **D2 excludes it.** Reasons: (1) protocol 10 removes "elementos não renderizados" and the contract
itself says this content is "not rendered, but part of U"; (2) D2 is "propositalmente o piso conservador: o denominador mais pequeno
possível dá a razão mais honesta"; (3) it is consistent downstream: QA questions are generated from D2 (protocol 9), so no
question has evidence in collapsed content, and the pruned arms are measured against the same text. The cost: a system that
keeps a collapsed unit gets no output for it, and nothing downstream measures that content. The effect is visible, not hidden:
the stage reports `tokens_d2_collapsed` (D2 with the collapsed content) per page and `stats.d2_collapsed` per system, and the
parameter `collapsed: "include"` switches D2 and the pruned output to the other reading. Changing the default is a decision for
the owner, before the first result.

## Pruned output

The same converter over the units a system keeps. K = the kept units whose text is rendered. An element survives when it is:

1. in K: with its own text;
2. an ancestor of an element of K: **as structure only, its own text removed** (non-blank direct text nodes; whitespace between
   inline children stays);
3. **decoration** of a kept element: a descendant, through kept or decoration elements, whose subtree has no unit (no own text):
   `<br>`, `<hr>`, `<img>`, empty wrappers.

Everything else goes: a non-kept unit with its subtree, siblings without a kept descendant, unrendered elements (the render
filter comes first, so a kept-but-hidden unit emits nothing). A unit the system does not label is not kept; an empty keep set
is the empty string. Tested cases: a list with one kept item, a table with one kept row, a title with the body removed, a link
kept inside a removed paragraph (plus first-and-last items, a kept element that is also a container, decoration, kept hidden units,
kept disclosure units, and "keep every rendered unit = the whole page"). Known consequences of using turndown on a pruned DOM:
an `<ol>` with only its 3rd item kept numbers it `1.`; a table whose header is not kept has no heading row and falls back to the
plugin's raw-HTML rule; text nodes sitting directly in a shadow root belong to the host in the stored html, so they follow the
host's decision. Elements with no `data-gp-id` (late, unstamped; `notes.unstamped_elements`) follow their parent: in the
whole page as it does, in the pruned output only inside content kept in full.

## Tokens and the empty output

`countTokens` is cl100k_base through `js-tiktoken`, text encoded as ordinary text (a page that contains `<|endoftext|>` is
counted as characters, not an error). It is not Claude's tokenizer: `countTokensClaude` (an interface `ClaudeTokenTransport`, a
fake, and `tokenDrift`) is the hook for the 30-page check against the API; **no call is made here**, the real transport needs
the owner's key and goes behind the budget ledger. The API counts a whole request, so measure its fixed overhead with
`claudeOverhead` and subtract it.

Reference vectors for the tokenizer: `test/fixtures/cl100k-vectors.json`, generated with OpenAI's `tiktoken` (python, 0.14.0,
`encode(text, disallowed_special=())`) by `test/fixtures/gen-cl100k-vectors.py`; two of the cases are also the examples in the tiktoken
README and the OpenAI cookbook (`"tiktoken is great!"` -> `[83, 1609, 5963, 374, 2294, 0]`).

Statistics (`summarizeRatios`): per page `r_p = tok(D) / tok(output)`; **median and IQR** (quantiles by linear interpolation, the
numpy default), never the mean; the pooled sum/sum ratio is secondary. **Empty output** (`tok(output) = 0`): the ratio would be
infinite and would reward a system that returns nothing (protocol 6.2: P = 0, F1 = 0), so an empty page counts with **reduction 0**
(fraction kept 1) in the median, at its full size in the pooled sums, and is counted in `n_empty`. A page whose full text is empty
has no ratio and is left out (`n_undefined`).

## API

`d1Html`, `stripGpAttributes`, `PageDom` (parse once, convert many), `htmlToMarkdown`, `planPage`, `isRenderedNode`,
`effectiveOpacities`, `countTokens`, `encodeTokens`, `converterVersions`, `converterLabel`, `tokenizerLabel`, `converterDigests`,
`summarizeRatios`, `summarizeByStratum`, `quantile`, `median`, `iqr`, `countTokensClaude`, `FakeClaudeTransport`, `tokenDrift`.
The package depends on no other `@gran-prix` package (structural `NodeLike`), so the Studio and the stages can both import it.
