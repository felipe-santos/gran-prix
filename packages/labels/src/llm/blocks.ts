import type { PageSnapshot } from "@gran-prix/contracts";
import type { Block } from "./types.js";

/**
 * Numbered DOM blocks (protocol 5.3). A block is a UNIT of the labels contract: an element that owns text.
 * Its id is `n<idx>`, the pre-order index of the composed tree (`data-gp-id`), so the mapping block id <->
 * node id is the identity, stable for one snapshot and independent of which blocks are sent. Blocks are in
 * document order (ascending idx = pre-order). The text is the element's own text as the snapshot recorded it
 * (whitespace collapsed), cut to `blockChars` code points.
 */

export interface BlockParams {
  /** Characters of text kept per block (protocol: 200). */
  block_chars: number;
  /** Ancestors kept in the path, the element included (protocol example: `main>article>p` = 3). */
  path_depth: number;
}

export const DEFAULT_BLOCK_PARAMS: BlockParams = { block_chars: 200, path_depth: 3 };

const cut = (text: string, max: number): string => {
  const cps = [...text];
  return cps.length <= max ? text : `${cps.slice(0, max).join("")}…`;
};

/** Blocks of `units` (snapshot idx, any order), in document order. Units without own text are dropped. */
export function buildBlocks(snapshot: PageSnapshot, units: readonly number[], params: BlockParams = DEFAULT_BLOCK_PARAMS): Block[] {
  const nodes = snapshot.nodes;
  const out: Block[] = [];
  for (const idx of [...new Set(units)].sort((a, b) => a - b)) {
    const node = nodes[idx];
    if (!node || node.own_text.trim() === "") continue;
    const chain: string[] = [];
    for (let k = idx; k >= 0 && chain.length < params.path_depth; k = nodes[k]?.parent ?? -1) chain.push(nodes[k]?.tag ?? "?");
    out.push({ unit_id: idx, id: `n${idx}`, tag: node.tag, path: chain.reverse().join(">"), text: cut(node.own_text, params.block_chars) });
  }
  return out;
}

/** One request worth of blocks: those to label plus read-only context placed before them. */
export interface Chunk {
  index: number;
  count: number;
  labeled: Block[];
  context: Block[];
}

/**
 * Splits the routed blocks (document order) in pieces of at most `chunkBlocks`; each piece carries up to
 * `ctxBlocks` blocks of context: the nearest blocks before its first labeled block that it does not label.
 */
export function chunkBlocks(all: readonly Block[], routed: ReadonlySet<number>, size: number, ctxBlocks: number): Chunk[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("chunk_blocks must be a positive integer");
  const target = all.filter((b) => routed.has(b.unit_id));
  const count = Math.ceil(target.length / size);
  const chunks: Chunk[] = [];
  for (let i = 0; i < count; i++) {
    const labeled = target.slice(i * size, (i + 1) * size);
    const own = new Set(labeled.map((b) => b.unit_id));
    const first = all.findIndex((b) => b.unit_id === (labeled[0] as Block).unit_id);
    const context: Block[] = [];
    for (let k = first - 1; k >= 0 && context.length < ctxBlocks; k--) {
      const b = all[k] as Block;
      if (!own.has(b.unit_id)) context.unshift(b);
    }
    chunks.push({ index: i, count, labeled, context });
  }
  return chunks;
}

const line = (b: Block): string => `${b.id}|${b.tag}|${b.path}|${JSON.stringify(b.text)}`;

export interface PageHeader {
  title: string;
  category: string;
}

/** The user message of one chunk (exact text sent, and hashed into the cache key). */
export function renderUserMessage(header: PageHeader, chunk: Chunk): string {
  const parts = [`TITLE: ${JSON.stringify(header.title)}`, `CATEGORY: ${JSON.stringify(header.category)}`, `PART: ${chunk.index + 1}/${chunk.count}`];
  parts.push(chunk.context.length > 0 ? "CONTEXT (do not label):" : "CONTEXT (do not label): none");
  for (const b of chunk.context) parts.push(line(b));
  parts.push(`BLOCKS (label every one, ${chunk.labeled.length}):`);
  for (const b of chunk.labeled) parts.push(line(b));
  return parts.join("\n");
}
