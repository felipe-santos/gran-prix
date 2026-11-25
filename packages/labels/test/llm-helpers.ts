import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactId, type NodeLabelItem, type NodeLabels, type PageSnapshot } from "@gran-prix/contracts";
import {
  DEFAULT_BLOCK_PARAMS,
  DEFAULT_ESTIMATE,
  DEFAULT_ROUTING,
  buildNodeLabels,
  promptFromGuideText,
  type LlmLedgerPort,
  type LlmRunConfig,
  type PageJob,
  type PriceTable,
} from "../src/index.js";

/** A guide with the same shape as the frozen one (sections 1-8); the real guide is checked in its own test. */
export const MINI_GUIDE = `# Guia de teste

> cabecalho

## 1. As tres classes

principal / suporte / ruido.

### 1.1 Roteiro

1. passo.

## 2. Unidade

unidade.

## 3. Regras transversais

regras.

## 4. Por categoria

categorias.

## 5. Conflitos

NAO deve ir ao prompt.

## 6. Interface

NAO.
`;

export const GUIDE_SHA = "ab".repeat(32);
export const PRICES: PriceTable = { input_usd_per_mtok: 3, output_usd_per_mtok: 15 };

/** Test double of the runner ledger: same contract (reserve throws `BudgetExceededError`, commit records the actual cost). */
export class TestLedger implements LlmLedgerPort {
  readonly events: Array<{ event: "reserve" | "commit" | "release"; usd: number; note?: string }> = [];
  private open = new Map<number, number>();
  private committed = 0;
  private n = 0;
  constructor(readonly capUSD: number) {}
  spent(): number {
    return this.committed + [...this.open.values()].reduce((a, b) => a + b, 0);
  }
  remainingUSD(): number {
    return Math.max(0, this.capUSD - this.spent());
  }
  reserve(cost: number, note?: string) {
    if (this.spent() + cost > this.capUSD + 1e-9) {
      const e = new Error(`budget cap exceeded: ${cost}`);
      e.name = "BudgetExceededError";
      throw e;
    }
    const id = this.n++;
    this.open.set(id, cost);
    this.events.push({ event: "reserve", usd: cost, ...(note ? { note } : {}) });
    return {
      commit: (actual: number = cost) => {
        this.open.delete(id);
        this.committed += actual;
        this.events.push({ event: "commit", usd: actual });
      },
      release: () => {
        this.open.delete(id);
        this.events.push({ event: "release", usd: 0 });
      },
    };
  }
  count(kind: "reserve" | "commit" | "release"): number {
    return this.events.filter((e) => e.event === kind).length;
  }
}

type Spec = [tag: string, parent: number, text: string, extra?: { disclosure?: boolean }];

/** A tiny snapshot: only the fields the labeler reads are real. */
export function makeSnapshot(id: string, specs: readonly Spec[], over: { category?: string; title?: string } = {}): PageSnapshot {
  const nodes = specs.map(([tag, parent, text, extra], idx) => ({
    idx,
    parent,
    depth: 0,
    tag,
    attrs: {},
    own_text: text,
    own_text_len: text.length,
    text_len: text.length,
    link_text_len: 0,
    child_elems: 0,
    style: { display: "block", visibility: "visible", opacity: 1, position: "static", font_size: 16, font_weight: 400 },
    rect: null,
    flags: { in_shadow: false, iframe_depth: 0, ...(extra?.disclosure ? { disclosure: true } : {}) },
  }));
  return {
    snapshot_id: artifactId({ id }),
    page: { url: `https://${id}.example/p`, final_url: `https://${id}.example/p`, url_key: `${id}.example/p`, group_key: `${id}.example`, category: over.category ?? "article", title: over.title ?? `Page ${id}` },
    nodes,
  } as unknown as PageSnapshot;
}

/** html > body > main > [h1, p x n, nav > a]: units are the elements that own text. */
export function articleSnapshot(id: string, paragraphs = 3, over: { category?: string } = {}): { snapshot: PageSnapshot; units: number[] } {
  const specs: Spec[] = [
    ["html", -1, ""],
    ["body", 0, ""],
    ["main", 1, ""],
    ["h1", 2, `Heading of ${id}`],
  ];
  for (let i = 0; i < paragraphs; i++) specs.push(["p", 2, `Paragraph ${i} of the page ${id}, long enough to be a block.`]);
  specs.push(["nav", 1, ""], ["a", specs.length, "Home"]);
  const snapshot = makeSnapshot(id, specs, over);
  return { snapshot, units: snapshot.nodes.filter((n) => n.own_text_len > 0).map((n) => n.idx) };
}

export function layer(snapshot: PageSnapshot, kind: "readability" | "heuristic" | "human", items: Array<[number, number]>, extra: Record<string, unknown> = {}, nCand?: number): NodeLabels {
  const source = kind;
  const list: NodeLabelItem[] = items.map(([unit_id, y]) => ({ unit_id, y, confidence: 0.7, source }));
  return buildNodeLabels({
    snapshot_id: snapshot.snapshot_id,
    labeler: { id: `${kind}@test`, kind, params: { kind } },
    items: list,
    n_candidates: nCand ?? items.length,
    extra,
  });
}

export function job(id: string, paragraphs = 3, layers: NodeLabels[] = [], over: { category?: string } = {}): PageJob {
  const a = articleSnapshot(id, paragraphs, over);
  return { name: a.snapshot.page.url_key, snapshot: a.snapshot, units: a.units, layers };
}

export function config(over: Partial<LlmRunConfig> = {}): LlmRunConfig {
  return {
    provider: "fake",
    model: "model-under-test",
    prices: PRICES,
    system: promptFromGuideText(MINI_GUIDE, GUIDE_SHA),
    send_temperature: true,
    output_tokens_per_block: 24,
    output_overhead_tokens: 512,
    max_output_tokens: 16000,
    expected_output_tokens_per_block: 20,
    estimate: DEFAULT_ESTIMATE,
    on_missing: "fail_page",
    retry_failed: false,
    chunk_blocks: 400,
    ctx_blocks: 10,
    block_chars: DEFAULT_BLOCK_PARAMS.block_chars,
    path_depth: DEFAULT_BLOCK_PARAMS.path_depth,
    confidence: 0.8,
    routing: { ...DEFAULT_ROUTING, mode: "all" },
    private_categories: ["logged_in"],
    dry_run: false,
    on_budget: "partial",
    ...over,
  };
}

const dirs: string[] = [];
export function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gp-llm-"));
  dirs.push(d);
  return d;
}
export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
