import { canonicalJson } from "@gran-prix/contracts";
import { SnapshotSetReader } from "@gran-prix/labels";
import {
  COLLAPSED_CONTENT_IN_D2,
  PageDom,
  converterDigests,
  converterLabel,
  converterVersions,
  countTokens,
  d1Html,
  tokenizerLabel,
  type CollapsedPolicy,
} from "@gran-prix/markdown";
import { defineStage, type StageContext, type StageOutputs, type StagePlugin } from "../../stage.js";
import type { ArtifactHandle } from "../../store.js";
import { EMPTY_OUTPUT_POLICY, systemReport, type PageTokens } from "./report.js";
import { collectSystems, type SystemParams } from "./systems.js";

/**
 * `ts:measure.tokens@1.0.0` (E3.5, protocol section 10): the token cost of the page text, per page and per system.
 *
 * Per page: `tok(D1)` (rendered html without data-gp-*), `tok(D2)` (full-page markdown) and `tok(output)` of every
 * system (the SAME converter over the units the system keeps, plus the structure of their ancestors), all with
 * cl100k_base. Aggregates per system: r_p = tok(D)/tok(output), median and IQR overall and per stratum, D1 and D2
 * side by side, the pooled sum/sum ratio as secondary. The artifact carries each system's `token_reduction` block in
 * the EvalReport v1.1 shape and per-page `tokens_d1 / tokens_d2 / tokens_kept` ready for `per_group[]`.
 *
 * `determinism: "pure"`: the cache key folds in the digests of turndown, the GFM plugin, js-tiktoken, jsdom and the
 * converter version (`toolDigests`), so upgrading any of them invalidates the stage.
 */

export const TOKENS_IMPL = "ts:measure.tokens@1.0.0";
export const TOKENS_FORMAT = "gran-prix.token-measure";

interface Params extends SystemParams {
  collapsed?: CollapsedPolicy;
  write_markdown?: boolean;
}

const PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    keep_classes: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: "Label classes that mean keep for NodeLabels systems (default main + support; ignored for a binary label space)." },
    names: { type: "array", items: { type: "string", minLength: 1 }, description: "Ids of the systems in port order (`systems`, then `predictions`); default: the labeler kind / the bundle's id. Letters, digits, '.', '_', '-'." },
    collapsed: { enum: ["exclude", "include"], description: `Content of collapsed disclosures in D2 and in the pruned output (default "${COLLAPSED_CONTENT_IN_D2}", the frozen decision of @gran-prix/markdown).` },
    write_markdown: { type: "boolean", description: "Write the D2 and pruned markdown of every page to the `markdown` output (default true; they are what the QA stage reads)." },
  },
} as const;

const hex12 = (snapshotId: string): string => snapshotId.slice("sha256:".length, "sha256:".length + 12);
const groupId = (groupKey: string, snapshotId: string): string => `${groupKey}#${hex12(snapshotId)}`;
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

export const measureTokens: StagePlugin = defineStage(
  {
    kind: "evaluate",
    impl: TOKENS_IMPL,
    inputs: [
      { name: "snapshots", type: "SnapshotSet" },
      { name: "systems", type: "NodeLabelsSet", many: true, optional: true },
      { name: "predictions", type: "Bundle", many: true, optional: true },
    ],
    outputs: [
      { name: "tokens", type: "Bundle" },
      { name: "markdown", type: "Bundle" },
    ],
    params_schema: PARAMS_SCHEMA,
    runtime: "node",
    determinism: "pure",
  },
  (ctx: StageContext): StageOutputs => {
    const params = ctx.params as Params;
    const collapsed: CollapsedPolicy = params.collapsed ?? COLLAPSED_CONTENT_IN_D2;
    const writeMarkdown = params.write_markdown !== false;
    const snaps = new SnapshotSetReader(ctx.inputs["snapshots"] as ArtifactHandle);
    const entries = snaps.entries();
    if (entries.length === 0) throw new Error("the snapshot set holds no page");
    const systems = collectSystems(ctx, params);
    const versions = converterVersions();

    const files: Record<string, string> = {};
    const index: Array<{ snapshot_id: string; d2: string | null; out: Record<string, string> }> = [];
    const pages: PageTokens[] = [];
    const covered = new Map(systems.map((s) => [s.id, 0]));
    const seenHex = new Set<string>();

    for (const entry of entries) {
      const h = hex12(entry.snapshot_id);
      if (seenHex.has(h)) throw new Error(`two snapshots share the id prefix ${h}`);
      seenHex.add(h);
      const snapshot = snaps.snapshot(entry);
      const stored = snaps.html(entry);
      const nodes = snapshot.nodes;

      const d1 = d1Html(stored);
      const page = new PageDom(stored, nodes);
      try {
        const d2 = page.convert({ collapsed });
        const hasDisclosure = nodes.some((n) => n.flags.disclosure === true);
        const d2c = hasDisclosure && collapsed === "exclude" ? page.convert({ collapsed: "include" }).markdown : d2.markdown;
        const tD2 = countTokens(d2.markdown);
        const tokensOut: Record<string, number> = {};
        const nKeep: Record<string, number | null> = {};
        const outPaths: Record<string, string> = {};
        let unstamped = d2.unstamped;
        if (writeMarkdown) files[`d2/${h}.md`] = d2.markdown;
        for (const sys of systems) {
          const keep = sys.keepOf(entry.snapshot_id);
          nKeep[sys.id] = keep === null ? null : keep.size;
          if (keep === null) {
            tokensOut[sys.id] = 0;
            ctx.log(`${snapshot.page.url_key}: system "${sys.id}" has no labels for this page: empty output`);
            continue;
          }
          covered.set(sys.id, (covered.get(sys.id) ?? 0) + 1);
          const out = page.convert({ collapsed, keep });
          unstamped = Math.max(unstamped, out.unstamped);
          tokensOut[sys.id] = countTokens(out.markdown);
          if (writeMarkdown) {
            outPaths[sys.id] = `out/${sys.id}/${h}.md`;
            files[outPaths[sys.id] as string] = out.markdown;
          }
        }
        index.push({ snapshot_id: entry.snapshot_id, d2: writeMarkdown ? `d2/${h}.md` : null, out: outPaths });
        pages.push({
          snapshot_id: entry.snapshot_id,
          group_id: groupId(snapshot.page.group_key, entry.snapshot_id),
          group_key: snapshot.page.group_key,
          stratum: snapshot.page.category,
          url_key: snapshot.page.url_key,
          tokens_d1: countTokens(d1),
          tokens_d2: tD2,
          tokens_d2_collapsed: d2c === d2.markdown ? tD2 : countTokens(d2c),
          tokens_out: tokensOut,
          n_keep: nKeep,
          notes: {
            d1_bytes: bytes(d1),
            script_elements: nodes.filter((n) => n.tag === "script").length,
            shadow_nodes: nodes.filter((n) => n.flags.in_shadow).length,
            disclosure_nodes: nodes.filter((n) => n.flags.disclosure === true).length,
            unstamped_elements: unstamped,
          },
        });
      } finally {
        page.dispose();
      }
    }

    const labels = { tokenizer: tokenizerLabel(versions), converter: converterLabel(versions) };
    const doc = {
      format: TOKENS_FORMAT,
      format_version: "1.0.0",
      ...labels,
      versions,
      policy: {
        collapsed,
        empty_output: EMPTY_OUTPUT_POLICY,
        uncovered_units: "A unit a system does not label (or predict) is not kept.",
        uncovered_pages: "A page a system has no document or prediction for has an empty output.",
        d1: "documentElement.outerHTML of the stored (flattened, settled) html without data-gp-* attributes and without the doctype; inline <script> content is emptied by the collector (lower bound); open shadow roots are inlined.",
      },
      pages,
      systems: systems.map((s) => systemReport(pages, { id: s.id, origin: s.origin, pages_covered: covered.get(s.id) ?? 0 }, labels)),
    };
    const out: StageOutputs = { tokens: { json: JSON.parse(canonicalJson(doc)) as unknown } };
    files["index.json"] = `${canonicalJson({ format: `${TOKENS_FORMAT}.markdown-index`, format_version: "1.0.0", pages: index })}\n`;
    out["markdown"] = { files };
    return out;
  },
);

export const TOKENS_STAGES: readonly StagePlugin[] = [{ ...measureTokens, toolDigests: () => converterDigests() }];
