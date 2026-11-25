import type { ContentNode, ContentTree } from "../content-tree.js";
import type { PipelineSpec, Ref } from "../pipeline-spec.js";
import { Issues } from "./result.js";

function nodeChildren(n: ContentNode): ContentNode[] {
  switch (n.kind) {
    case "list":
      return n.items;
    case "quote":
    case "container":
      return n.children;
    default:
      return [];
  }
}

export function contentTreeInvariants(t: ContentTree): Issues {
  const out = new Issues("content-tree");
  const walk = (nodes: ContentNode[], at: string): void => {
    let prevFirst = -1;
    nodes.forEach((n, i) => {
      const p = `${at}[${i}]`;
      n.src.forEach((u, j) => {
        if (j > 0) out.check(u > (n.src[j - 1] as number), `${p}.src`, "src unit ids must be strictly increasing");
      });
      const first = n.src[0];
      if (first !== undefined) {
        out.check(first >= prevFirst, `${p}.src`, `siblings must follow document order (unit ${first} comes after ${prevFirst})`);
        prevFirst = first;
      }
      if (n.kind === "table" && n.headers.length > 0) {
        n.rows.forEach((row, r) =>
          out.check(row.length === n.headers.length, `${p}.rows[${r}]`, `row has ${row.length} cells, headers has ${n.headers.length}`),
        );
      }
      if (n.kind === "list") out.check(n.items.length > 0, `${p}.items`, "a list needs at least one item");
      const kids = nodeChildren(n);
      const field = n.kind === "list" ? "items" : "children";
      if (kids.length > 0) walk(kids, `${p}.${field}`);
    });
  };
  walk(t.root, "root");
  const s = t.stats;
  out.check(s.nodes_kept <= s.nodes_candidates, "stats.nodes_kept", "nodes_kept must be <= nodes_candidates");
  out.check(s.nodes_candidates <= s.nodes_total, "stats.nodes_candidates", "nodes_candidates must be <= nodes_total");
  out.check(s.chars_out <= s.chars_in, "stats.chars_out", "chars_out must be <= chars_in");
  return out;
}

/** Edges stage -> stage of a pipeline, in the order they are declared. */
export function refsOf(inputs: Record<string, Ref | Ref[]>): Array<{ port: string; ref: Ref; index: number | null }> {
  const res: Array<{ port: string; ref: Ref; index: number | null }> = [];
  for (const [port, v] of Object.entries(inputs)) {
    if (Array.isArray(v)) v.forEach((ref, index) => res.push({ port, ref, index }));
    else res.push({ port, ref: v, index: null });
  }
  return res;
}

/** Structural checks that need no registry: unique ids, resolvable refs, acyclic graph. */
export function pipelineStructureIssues(spec: PipelineSpec): Issues {
  const out = new Issues("pipeline-spec");
  const ids = new Map<string, number>();
  spec.stages.forEach((s, i) => {
    const prev = ids.get(s.id);
    if (prev !== undefined) out.invariant(`stages[${i}].id`, `duplicate stage id "${s.id}" (also stages[${prev}])`);
    ids.set(s.id, i);
  });
  const deps = new Map<string, Set<string>>();
  spec.stages.forEach((s, i) => {
    const d = new Set<string>();
    for (const { port, ref, index } of refsOf(s.inputs)) {
      const at = `stages[${i}].inputs.${port}${index === null ? "" : `[${index}]`}`;
      if ("external" in ref) {
        out.check(spec.externals !== undefined && ref.external in spec.externals, at, `external "${ref.external}" is not declared in externals`);
      } else {
        out.check(ids.has(ref.stage), at, `refers to unknown stage "${ref.stage}"`);
        out.check(ref.stage !== s.id, at, "a stage cannot consume its own output");
        d.add(ref.stage);
      }
    }
    deps.set(s.id, d);
  });
  // Cycle detection (DFS with colors); reports one cycle path.
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): boolean => {
    color.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      if (!ids.has(d)) continue;
      const c = color.get(d) ?? 0;
      if (c === 1) {
        out.invariant("stages", `dependency cycle: ${[...stack.slice(stack.indexOf(d)), d].join(" -> ")}`);
        return true;
      }
      if (c === 0 && visit(d)) return true;
    }
    stack.pop();
    color.set(id, 2);
    return false;
  };
  for (const s of spec.stages) if ((color.get(s.id) ?? 0) === 0 && visit(s.id)) break;
  return out;
}
