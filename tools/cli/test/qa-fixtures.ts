// Shared helpers of the QA tool tests: a ledger port over the real Ledger, call models, and synthetic task sets.
import { join } from "node:path";
import { contractId, type QaTaskSet, type Sha256 } from "@gran-prix/contracts";
import type { LlmLedgerPort } from "@gran-prix/labels";
import { Ledger } from "../src/ledger.js";
import { MarkdownBundle } from "../src/stages/qa/arms.js";
import type { CallModel } from "../src/stages/qa/call.js";
import { resolveParams } from "../src/stages/qa/model-params.js";
import { tmpDir } from "./helpers.js";

export const PRICES = { input_usd_per_mtok: 3, output_usd_per_mtok: 15 }; // example prices for the tests, not a claim about any model

/** The real ledger (a file with a hard cap) seen as the port the QA calls use. */
export function ledgerPort(cap: number): { port: LlmLedgerPort; ledger: Ledger } {
  const ledger = new Ledger(join(tmpDir("qa-ledger-"), "ledger.jsonl"), cap);
  const port: LlmLedgerPort = {
    reserve: (usd, note) => ledger.reserve(usd, note === undefined ? {} : { note }),
    get capUSD() {
      return ledger.capUSD;
    },
    remainingUSD: () => ledger.remainingUSD(),
  };
  return { port, ledger };
}

export const callModel = (model = "test-sonnet-model", provider = "fake"): CallModel => ({ provider, model, prices: PRICES, params: resolveParams(model) });

export const HASH = (c: string): Sha256 => `sha256:${c.repeat(64)}`;

export interface TaskSpec {
  page: string;
  stratum: string;
  kind?: "main" | "category" | "support";
  n?: number;
  question?: string;
  answer?: string;
  variants?: string[];
  quote?: string;
}

/** A valid QaTaskSet of synthetic tasks: pages `<page>.test#<hex12>`, two tasks per page by default. */
export function taskSet(specs: TaskSpec[]): QaTaskSet {
  const pages = new Map<string, { group_id: string; snapshot_id: Sha256; stratum: string; split: "test"; prediction: "frozen_model" }>();
  const tasks: QaTaskSet["tasks"] = [];
  specs.forEach((s, i) => {
    const hex = (s.page.length.toString(16) + "0".repeat(11) + i.toString(16)).slice(0, 12).padEnd(12, "0");
    const hexFull = `${hex}${"0".repeat(52)}`;
    const group_id = `${s.page}.test#${hex}`;
    if (!pages.has(group_id)) pages.set(group_id, { group_id, snapshot_id: `sha256:${hexFull}`, stratum: s.stratum, split: "test", prediction: "frozen_model" });
    for (let k = 0; k < (s.n ?? 1); k++) {
      tasks.push({
        id: `${group_id}/r${tasks.length + 1}`,
        group_id,
        stratum: s.stratum,
        kind: s.kind ?? "main",
        question: s.question === undefined ? `Question ${tasks.length + 1}?` : (s.n ?? 1) > 1 ? s.question.replace(/\?$/, ` #${k + 1}?`) : s.question,
        answer: s.answer ?? `answer${tasks.length + 1}`,
        answer_variants: s.variants ?? [],
        evidence: { unit_ids: [1], quote: s.quote ?? `evidence quote ${tasks.length + 1}`, class: "main" },
        validation: { status: "accepted", by: "human", candidate_rank: 1 },
      });
    }
  });
  const base = {
    format: "gran-prix.qa-task-set" as const,
    format_version: "1.0.0" as const,
    generator: { model: "gen-model", prompt_sha256: HASH("a"), source: "D2 full-page markdown" },
    pages: [...pages.values()],
    tasks,
    review: { n_candidates: tasks.length, n_accepted: tasks.length, n_rejected: 0, rejection_rate: 0, human_reviewed: true },
  };
  const provenance = {
    produced_by: { run_id: "x", stage_id: "x", kind: "evaluate", impl: "x", params_sha256: HASH("b"), cache_key: HASH("c") },
    inputs: [],
    pipeline_spec_id: HASH("d"),
    tool_versions: { gp_cli: "0", node: "0" },
    created_at: "1970-01-01T00:00:00Z",
    duration_ms: 0,
  };
  return { ...base, task_set_id: contractId("qa-task-set", base as unknown as Record<string, unknown>), provenance } as QaTaskSet;
}

/** An in-memory `markdown` bundle (what `ts:measure.tokens` writes): d2/<hex12>.md and out/<system>/<hex12>.md. */
export function bundleOf(ts: QaTaskSet, texts: { d2: (snapshotId: string, stratum: string) => string; systems?: Record<string, (snapshotId: string, stratum: string) => string | null> }): MarkdownBundle {
  const files = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  for (const p of ts.pages) {
    const hex = p.snapshot_id.slice("sha256:".length, "sha256:".length + 12);
    files.set(`d2/${hex}.md`, enc.encode(texts.d2(p.snapshot_id, p.stratum)));
    for (const [sys, f] of Object.entries(texts.systems ?? {})) {
      const t = f(p.snapshot_id, p.stratum);
      if (t !== null) files.set(`out/${sys}/${hex}.md`, enc.encode(t));
    }
  }
  return new MarkdownBundle({ files: () => [...files.keys()], file: (p) => files.get(p) as Uint8Array });
}
