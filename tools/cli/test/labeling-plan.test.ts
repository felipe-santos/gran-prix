// scripts/labeling-plan-dom-v0.mjs and its libs: the by-hash selections, the Studio queue contract, the cost arithmetic.
// Pure functions over synthetic pages: no corpus, no network, no key.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types
import { QUEUE_FORMAT, TASKS, buildQueue, pageTokens, retestNotBefore } from "../../../scripts/labeling-plan-dom-v0.mjs";
// @ts-expect-error plain .mjs without types
import { HAIKU_TIER_TOKENS, modelCost, phaseCost } from "../../../scripts/lib/labeling-cost.mjs";
// @ts-expect-error plain .mjs without types
import { renderPlanMarkdown } from "../../../scripts/lib/labeling-render.mjs";
// @ts-expect-error plain .mjs without types
import { ORDER_PREFIX, PURPOSES, orderHash, selectPages, sortedFor } from "../../../scripts/lib/labeling-select.mjs";

interface P {
  snapshot_id: string;
  url: string;
  category: string;
  split: "train" | "val" | "test";
}

/** The frozen corpus counts (frame-v0, salt gp-dom-v0-s10): category -> [train, val, test]. */
const COUNTS: Record<string, [number, number, number]> = {
  article: [17, 7, 6],
  product: [19, 5, 6],
  docs: [17, 6, 7],
  forum: [20, 3, 7],
  landing: [17, 1, 7],
  spa: [8, 1, 3],
};

function corpus(): P[] {
  const out: P[] = [];
  for (const [category, n] of Object.entries(COUNTS)) {
    (["train", "val", "test"] as const).forEach((split, i) => {
      for (let k = 0; k < n[i]!; k++) out.push({ snapshot_id: `sha256:${createHash("sha256").update(`${category}${split}${k}`).digest("hex")}`, url: `https://site-${category}-${split}-${k}.example/page`, category, split });
    });
  }
  return out;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const ids = (l: P[]): string[] => l.map((p) => p.snapshot_id);

describe("selections by hash", () => {
  const pages = corpus();
  const sel = selectPages(pages);

  it("the fixture has the frozen shape: 157 pages, 98/23/36", () => {
    expect(pages).toHaveLength(157);
    expect(["train", "val", "test"].map((s) => pages.filter((p) => p.split === s).length)).toEqual([98, 23, 36]);
  });

  it("uses the documented formula sha256('gp-dom-v0|20261125|<purpose>|' + url), ascending", () => {
    expect(ORDER_PREFIX).toBe("gp-dom-v0|20261125|");
    const url = "https://example.com/a";
    expect(orderHash("audit", url)).toBe(sha(`gp-dom-v0|20261125|audit|${url}`));
    for (const purpose of PURPOSES) {
      const order = sortedFor(purpose, pages).map((p: P) => orderHash(purpose, p.url));
      expect(order).toEqual([...order].sort());
    }
    // purposes are independent orders
    expect(ids(sortedFor("audit", pages))).not.toEqual(ids(sortedFor("retest", pages)));
  });

  it("sizes: prompt-dev 10 (train), audit 28 (5 per category, the SPA has 3), retest 10, train-sample 10, test-review 8", () => {
    expect(sel["prompt-dev"]).toHaveLength(10);
    expect(sel["prompt-dev"].every((p: P) => p.split === "train")).toBe(true);
    expect(sel.audit).toHaveLength(28);
    expect(sel.audit.every((p: P) => p.split === "test")).toBe(true);
    expect(sel.audit_by_category).toEqual({ article: 5, docs: 5, forum: 5, landing: 5, product: 5, spa: 3 });
    expect(sel.retest).toHaveLength(10);
    expect(sel.n_train_sample).toBe(Math.ceil(0.1 * 98));
    expect(sel["train-sample"]).toHaveLength(10);
    expect(sel["test-review"]).toHaveLength(8);
  });

  it("the sets relate as the protocol says", () => {
    const audit = new Set(ids(sel.audit));
    expect(ids(sel.retest).every((i) => audit.has(i))).toBe(true);
    const promptDev = new Set(ids(sel["prompt-dev"]));
    expect(ids(sel["train-sample"]).some((i) => promptDev.has(i))).toBe(false);
    expect(sel["train-sample"].every((p: P) => p.split === "train")).toBe(true);
    const test = pages.filter((p) => p.split === "test");
    expect(new Set([...audit, ...ids(sel["test-review"])])).toEqual(new Set(ids(test)));
    expect(ids(sel["test-review"]).some((i) => audit.has(i))).toBe(false);
  });

  it("takes the FIRST pages of each purpose order: nobody chooses", () => {
    const train = pages.filter((p) => p.split === "train");
    expect(ids(sel["prompt-dev"])).toEqual(ids(sortedFor("prompt-dev", train).slice(0, 10)));
    for (const c of Object.keys(COUNTS)) {
      const mine = sel.audit.filter((p: P) => p.category === c);
      const first = sortedFor("audit", pages.filter((p) => p.split === "test" && p.category === c)).slice(0, 5);
      expect(new Set(ids(mine))).toEqual(new Set(ids(first)));
    }
  });

  it("is deterministic and independent of the input order", () => {
    const shuffled = [...pages].reverse();
    const again = selectPages(shuffled);
    for (const t of PURPOSES) expect(ids(again[t])).toEqual(ids(sel[t]));
  });
});

describe("Studio queues (contract gran-prix.label-queue 1.0.0)", () => {
  const pages = corpus();
  const sel = selectPages(pages);

  it("has exactly the contract fields, the right mode per task, and the page fields", () => {
    expect(QUEUE_FORMAT).toBe("gran-prix.label-queue");
    const modes = Object.fromEntries(PURPOSES.map((t: string) => [t, TASKS[t].mode]));
    expect(modes).toEqual({ "prompt-dev": "blind", audit: "blind", retest: "blind", "train-sample": "review", "test-review": "review" });
    for (const t of PURPOSES as string[]) {
      const q = buildQueue(t, sel[t], "sha256:abc");
      expect(Object.keys(q)).toEqual(["format", "format_version", "task", "mode", "plan_sha256", "not_before", "pages"]);
      expect(q).toMatchObject({ format: "gran-prix.label-queue", format_version: "1.0.0", task: t, mode: modes[t], plan_sha256: "sha256:abc", not_before: null });
      expect(q.pages).toHaveLength(sel[t].length);
      for (const p of q.pages) expect(Object.keys(p)).toEqual(["snapshot_id", "url", "category", "split"]);
      expect(JSON.parse(JSON.stringify(q))).toEqual(q);
    }
  });

  it("the retest opens 7 days after the audit; without a date it is null", () => {
    expect(retestNotBefore(undefined)).toBeNull();
    expect(retestNotBefore("2026-12-01T10:00:00Z")).toBe("2026-12-08");
    expect(retestNotBefore("2026-12-28")).toBe("2027-01-04");
    expect(() => retestNotBefore("not a date")).toThrow(/not a date/);
    expect(buildQueue("retest", sel.retest, "sha256:abc", "2026-12-08").not_before).toBe("2026-12-08");
  });
});

describe("tokens of a page", () => {
  it("chunks by 400 with 10 context blocks and counts the exact user message", () => {
    const nodes = [{ tag: "html", parent: -1, own_text: "" }];
    for (let i = 1; i <= 450; i++) nodes.push({ tag: "p", parent: 0, own_text: `Paragraph number ${i} of the page.` });
    const snapshot = { snapshot_id: "sha256:x", page: { title: "T", category: "article" }, nodes };
    const lib = {
      buildBlocks: (s: typeof snapshot, units: number[]) => units.map((u) => ({ unit_id: u, id: `n${u}`, tag: "p", path: "html>p", text: s.nodes[u]!.own_text })),
      chunkBlocks: (all: Array<{ unit_id: number }>, routed: Set<number>, size: number, ctx: number) => {
        const target = all.filter((b) => routed.has(b.unit_id));
        return Array.from({ length: Math.ceil(target.length / size) }, (_, i) => ({ index: i, count: 0, labeled: target.slice(i * size, (i + 1) * size), context: i === 0 ? [] : all.slice(0, ctx) }));
      },
      renderUserMessage: (_h: unknown, c: { labeled: unknown[]; context: unknown[] }) => "x".repeat(c.labeled.length * 40 + c.context.length * 40),
      countTokens: (t: string) => Math.ceil(t.length / 4),
    };
    const units = nodes.map((_, i) => i).slice(1);
    const r = pageTokens({ snapshot, units, routed: units, lib, cfg: { block: {}, chunk_blocks: 400, ctx_blocks: 10 } });
    expect(r).toMatchObject({ eligible_units: 450, units_sent: 450, context_blocks: 10 });
    expect(r.chunks.map((c: { n_blocks: number }) => c.n_blocks)).toEqual([400, 50]);
    const half = pageTokens({ snapshot, units, routed: units.slice(0, 100), lib, cfg: { block: {}, chunk_blocks: 400, ctx_blocks: 10 } });
    expect(half.units_sent).toBe(100);
    expect(half.chunks).toHaveLength(1);
  });
});

describe("cost arithmetic", () => {
  const prices = { input_usd_per_mtok: 2, output_usd_per_mtok: 10, cache_write_usd_per_mtok: 2.5, cache_read_usd_per_mtok: 0.1 };
  const chunks = [
    { user_tokens: 1_000_000, out_tokens: 100_000 },
    { user_tokens: 1_000_000, out_tokens: 100_000 },
  ];

  it("charges the system prompt as a write once and as reads afterwards, user tokens as input, answers as output", () => {
    // expected: retry 5% -> ceil(2 * 0.05) = 1 retried call -> 3 calls; user 2M x 1.05; out 0.2M x 1.05
    const c = phaseCost({ chunks, system_tokens: 100_000, prices, scenario: "expected", thinking_on: false, thinking_headroom_tokens: 0 });
    expect(c.calls).toBe(3);
    expect(c.cache_write_tokens).toBe(100_000);
    expect(c.cache_read_tokens).toBe(200_000);
    const want = (2_100_000 * 2 + 100_000 * 2.5 + 200_000 * 0.1 + 210_000 * 10) / 1_000_000;
    expect(c.usd).toBeCloseTo(want, 9);
    expect(c.thinking_tokens).toBe(0);
  });

  it("iterations rewrite the cache once each, and multiply the tokens", () => {
    const one = phaseCost({ chunks, system_tokens: 1000, prices, scenario: "expected", thinking_on: false, thinking_headroom_tokens: 0 });
    const three = phaseCost({ chunks, system_tokens: 1000, prices, iterations: 3, scenario: "expected", thinking_on: false, thinking_headroom_tokens: 0 });
    expect(three.cache_write_tokens).toBe(3000);
    expect(three.uncached_input_tokens).toBeGreaterThan(2.9 * one.uncached_input_tokens);
  });

  it("the upper scenario scales tokens by the declared uncertainty and bills the thinking headroom only where thinking runs", () => {
    const base = { chunks, system_tokens: 1000, prices, scenario: "upper" as const, thinking_headroom_tokens: 8000 };
    const off = phaseCost({ ...base, thinking_on: false });
    const on = phaseCost({ ...base, thinking_on: true });
    expect(off.thinking_tokens).toBe(0);
    expect(on.thinking_tokens).toBe(8000 * on.calls);
    expect(on.usd - off.usd).toBeCloseTo((8000 * on.calls * 10) / 1_000_000, 9);
    const exp = phaseCost({ ...base, scenario: "expected", thinking_on: true });
    expect(exp.thinking_tokens).toBe(0); // unmeasured: not guessed in the expected scenario
    expect(off.usd).toBeGreaterThan(exp.usd * 1.3);
  });

  it("totals the phases, checks the cap and the Haiku 100k tier", () => {
    const phases = [
      { name: "a", pages: 1, chunks, iterations: 1, interactive: false },
      { name: "b", pages: 1, chunks, iterations: 3, interactive: true },
    ];
    const model = { id: "claude-sonnet-5-5", configuration: "x", prices, thinking_on: false, thinking_headroom_tokens: 0, thinking_note: "n" };
    const m = modelCost({ model, system_tokens: 5000, phases, cap_usd: 25 });
    expect(m.totals.expected.usd).toBeCloseTo(m.phases[0].expected.usd + m.phases[1].expected.usd, 9);
    expect(m.within_cap.expected).toBe(m.totals.expected.usd <= 25);
    expect(modelCost({ model, system_tokens: 5000, phases, cap_usd: 1 }).within_cap.upper).toBe(false);
    expect(m.haiku_tier_ok).toBeNull();
    const haiku = modelCost({ model: { ...model, id: "claude-haiku-5-5" }, system_tokens: 5000, phases, cap_usd: 25 });
    expect(haiku.haiku_tier_ok).toBe(false); // 1M-token chunks: far above the tier
    expect(haiku.max_prompt_tokens_upper).toBeGreaterThan(HAIKU_TIER_TOKENS);
    const small = modelCost({ model: { ...model, id: "claude-haiku-5-5" }, system_tokens: 5000, phases: [{ name: "a", pages: 1, chunks: [{ user_tokens: 20_000, out_tokens: 500 }], iterations: 1, interactive: false }], cap_usd: 25 });
    expect(small.haiku_tier_ok).toBe(true);
    expect(m.batch_info.expected_usd_if_batched).toBeLessThan(m.totals.expected.usd);
  });

  it("renders a readable summary with every section", () => {
    const sel = selectPages(corpus());
    const mk = (t: string) => ({ mode: TASKS[t].mode, human_task: TASKS[t].human_task, pages: sel[t], by_category: {}, by_split: {} });
    const model = modelCost({
      model: { id: "claude-sonnet-5-5", configuration: "cfg", prices, thinking_on: false, thinking_headroom_tokens: 0, thinking_note: "note" },
      system_tokens: 5000,
      phases: [{ name: "audit", pages: 1, chunks, iterations: 1, interactive: false }],
      cap_usd: 25,
    });
    const md = renderPlanMarkdown({
      categories: ["article"],
      inputs: { corpus: "c", pages: 157, lock_sha256: `sha256:${"a".repeat(64)}`, split: { salt: "s" }, guide_sha256: "b".repeat(64), pipeline_sha256: `sha256:${"c".repeat(64)}` },
      selection_formula: "f",
      selections: Object.fromEntries(PURPOSES.map((t: string) => [t, mk(t)])),
      corpus_by_split: [{ split: "train", total: 98 }],
      corpus_split_by_category: { article: { train: 17, val: 7, test: 6 } },
      phases: [{ name: "audit", pages: 28, routing: "all", eligible_units: 10, units_sent: 10, context_blocks: 0, chunks: 1, user_tokens: 100, out_tokens: 10 }],
      system_prompt: { tokens_cl100k: 5000, chars: 20000, prompt_sha256: `sha256:${"d".repeat(64)}` },
      routing_dev: { pages: 1, eligible_units: 100, units_sent: 50, whole_page_pages: 0, whole_page_reasons: {}, by_reason: { disagreement: 50 } },
      cost: { cap_usd: 25, models: [model], assumptions: ["a"] },
      interpretations: ["i"],
    });
    for (const h of ["# Labeling plan v0", "## Selections", "## What goes to the LLM", "## Cost per model", "claude-sonnet-5-5", "## Interpretations"]) expect(md).toContain(h);
  });
});
