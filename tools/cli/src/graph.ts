import type { PipelineSpec } from "@gran-prix/contracts";

type Stage = PipelineSpec["stages"][number];

/** Stage ids a stage reads from (deduplicated, in first-use order). */
export function dependenciesOf(stage: Stage): string[] {
  const out: string[] = [];
  for (const v of Object.values(stage.inputs)) {
    for (const ref of Array.isArray(v) ? v : [v]) {
      if ("stage" in ref && !out.includes(ref.stage)) out.push(ref.stage);
    }
  }
  return out;
}

/**
 * Kahn's algorithm with declaration order as the tie-break, so the order is
 * deterministic. Throws on a cycle (the contract validator rejects cycles
 * first; this guards direct callers).
 */
export function topologicalOrder(spec: PipelineSpec): string[] {
  const deps = new Map(spec.stages.map((s) => [s.id, dependenciesOf(s)]));
  const done = new Set<string>();
  const order: string[] = [];
  while (order.length < spec.stages.length) {
    const next = spec.stages.find((s) => !done.has(s.id) && (deps.get(s.id) ?? []).every((d) => done.has(d)));
    if (!next) throw new Error("pipeline has a dependency cycle");
    done.add(next.id);
    order.push(next.id);
  }
  return order;
}

/** `start` and everything reachable from it following `next` edges. */
function closure(start: string, next: (id: string) => readonly string[]): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const n of next(queue.pop() as string)) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

export interface Selection {
  /** Stages that run (subject to the cache): descendants-or-self of `from` that are ancestors-or-self of `to`. */
  readonly active: ReadonlySet<string>;
  /** Ancestors of active stages that are not active: resolved from the cache only, never executed. */
  readonly frozen: ReadonlySet<string>;
}

/**
 * `--from A --to B`: a stage is ACTIVE when it is A or downstream of A, and
 * B or upstream of B (no bound = unbounded). Stages upstream of active ones
 * that are not active are FROZEN: their outputs must already be in the cache.
 * Everything else is untouched.
 */
export function select(spec: PipelineSpec, from?: string, to?: string): Selection {
  const ids = new Set(spec.stages.map((s) => s.id));
  for (const [flag, id] of [["--from", from], ["--to", to]] as const) {
    if (id !== undefined && !ids.has(id)) throw new Error(`${flag} ${id}: no such stage (stages: ${[...ids].join(", ")})`);
  }
  const deps = new Map(spec.stages.map((s) => [s.id, dependenciesOf(s)]));
  const children = new Map<string, string[]>(spec.stages.map((s) => [s.id, []]));
  for (const [id, ds] of deps) for (const d of ds) children.get(d)?.push(id);

  const down = from === undefined ? ids : closure(from, (id) => children.get(id) ?? []);
  const up = to === undefined ? ids : closure(to, (id) => deps.get(id) ?? []);
  const active = new Set([...ids].filter((id) => down.has(id) && up.has(id)));
  const frozen = new Set<string>();
  for (const id of active) {
    for (const a of closure(id, (x) => deps.get(x) ?? [])) if (!active.has(a)) frozen.add(a);
  }
  return { active, frozen };
}
