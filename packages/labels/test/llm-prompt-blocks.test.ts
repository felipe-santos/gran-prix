import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  OUTPUT_INSTRUCTIONS,
  buildBlocks,
  buildSystemPrompt,
  chunkBlocks,
  correctionMessage,
  extractGuideSections,
  promptFromGuideText,
  renderUserMessage,
  validateAnswer,
  isClean,
} from "../src/index.js";
import { GUIDE_SHA, MINI_GUIDE, articleSnapshot, cleanup, makeSnapshot, tmp } from "./llm-helpers.js";

afterAll(cleanup);

const FROZEN = "/home/ubuntu/files/PRIX/gran-prix/IDEIAS/plano/guia-de-anotacao.md";
const FROZEN_SHA = "55ea22739d1d5090ec6eb8ff3d8b81e49e387ea350af6622a1e610dc05b4c1e5"; // plano/prereg-dom-v0.txt

describe("system prompt built from the frozen guide", () => {
  it("takes sections 1-4 verbatim and nothing from 5 onwards", () => {
    const s = extractGuideSections(MINI_GUIDE);
    expect(s.startsWith("## 1. As tres classes")).toBe(true);
    expect(s).toContain("## 4. Por categoria");
    expect(s).not.toContain("## 5.");
    expect(s).not.toContain("NAO deve ir");
    expect(s).not.toContain("cabecalho");
  });

  it("records the guide sha256 and a prompt sha256 that follows every byte", () => {
    const p = promptFromGuideText(MINI_GUIDE, GUIDE_SHA);
    expect(p.guide_sha256).toBe(GUIDE_SHA);
    expect(p.system).toContain(`sha256 ${GUIDE_SHA}`);
    expect(p.system).toContain(OUTPUT_INSTRUCTIONS);
    expect(p.prompt_sha256).toBe(`sha256:${createHash("sha256").update(p.system).digest("hex")}`);
    const changed = promptFromGuideText(MINI_GUIDE.replace("principal / suporte", "principal / SUPORTE"), GUIDE_SHA);
    expect(changed.prompt_sha256).not.toBe(p.prompt_sha256);
    expect(changed.sections_sha256).not.toBe(p.sections_sha256);
  });

  it("reads the file, checks the pinned hash, and refuses a changed guide", () => {
    const f = join(tmp(), "guide.md");
    writeFileSync(f, MINI_GUIDE);
    const sha = createHash("sha256").update(readFileSync(f)).digest("hex");
    expect(buildSystemPrompt(f, sha).guide_sha256).toBe(sha);
    expect(buildSystemPrompt(f, `sha256:${sha}`).guide_sha256).toBe(sha);
    expect(() => buildSystemPrompt(f, "0".repeat(64))).toThrow(/frozen guide changed/);
    writeFileSync(f, "# no sections here\n");
    expect(() => buildSystemPrompt(f, undefined)).toThrow(/no `## 1\.`/);
  });

  it.skipIf(!existsSync(FROZEN))("builds from the real frozen guide whose hash is pinned in prereg-dom-v0.txt", () => {
    const p = buildSystemPrompt(FROZEN, FROZEN_SHA);
    expect(p.guide_sha256).toBe(FROZEN_SHA);
    expect(p.sections_text).toContain("## 1. As três classes");
    expect(p.sections_text).toContain("## 4. Por categoria");
    expect(p.sections_text).not.toContain("## 5. Conflitos");
    expect(p.system.length).toBeGreaterThan(10_000);
  });
});

describe("block numbering", () => {
  const { snapshot, units } = articleSnapshot("a", 4);

  it("ids are n<idx>, in document order, whatever the order or repetition of the units given", () => {
    const a = buildBlocks(snapshot, units);
    const b = buildBlocks(snapshot, [...units].reverse().concat(units));
    expect(a).toEqual(b);
    expect(a.map((x) => x.id)).toEqual(units.map((u) => `n${u}`));
    expect(a.map((x) => x.unit_id)).toEqual([...units].sort((x, y) => x - y));
    expect(a[0]).toMatchObject({ id: "n3", tag: "h1", path: "body>main>h1" });
  });

  it("is deterministic across calls and drops units with no text", () => {
    expect(JSON.stringify(buildBlocks(snapshot, units))).toBe(JSON.stringify(buildBlocks(snapshot, units)));
    expect(buildBlocks(snapshot, [0, 1, 2]).length).toBe(0);
  });

  it("cuts the text to block_chars code points and keeps the path depth", () => {
    const s = makeSnapshot("c", [["html", -1, ""], ["body", 0, ""], ["div", 1, ""], ["p", 2, "x".repeat(300)]]);
    const [b] = buildBlocks(s, [3], { block_chars: 200, path_depth: 2 });
    expect([...(b?.text ?? "")].length).toBe(201); // 200 + the ellipsis
    expect(b?.path).toBe("div>p");
  });

  it("renders the protocol line n123|tag|path|\"text\" and chunks with context", () => {
    const blocks = buildBlocks(snapshot, units);
    const routed = new Set(units.slice(2)); // the first two blocks stay out: they become context
    const chunks = chunkBlocks(blocks, routed, 2, 10);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.context.map((b) => b.unit_id)).toEqual(units.slice(0, 2));
    expect(chunks[1]?.context.map((b) => b.unit_id)).toEqual(units.slice(0, 4)); // everything before it that it does not label
    const msg = renderUserMessage({ title: "T", category: "article" }, chunks[0]!);
    expect(msg).toContain('TITLE: "T"');
    expect(msg).toContain("PART: 1/2");
    expect(msg).toMatch(/CONTEXT \(do not label\):\nn3\|h1\|body>main>h1\|"Heading of a"\n/);
    expect(msg).toContain("BLOCKS (label every one, 2):");
    expect(renderUserMessage({ title: "T", category: "article" }, chunks[0]!)).toBe(msg);
  });
});

describe("response validation", () => {
  const ids = ["n1", "n2", "n3"];
  const ok = (labels: unknown[]): string => JSON.stringify({ labels });
  const row = (id: string, c = "M") => ({ id, c, u: false, m: false });

  it("accepts a complete, exact answer", () => {
    const v = validateAnswer(ok(ids.map((i) => row(i))), ids);
    expect(isClean(v)).toBe(true);
    expect(v.answers.map((a) => a.id)).toEqual(ids);
  });

  it("reports unknown, repeated and missing ids", () => {
    const v = validateAnswer(ok([row("n1"), row("n1"), row("n9"), row("n3", "S")]), ids);
    expect(v.unknown).toEqual(["n9"]);
    expect(v.duplicates).toEqual(["n1"]);
    expect(v.missing).toEqual(["n2"]);
    expect(isClean(v)).toBe(false);
    expect(correctionMessage(v)).toMatch(/not asked: n9.*more than once: n1.*no answer: n2/);
  });

  it("rejects malformed JSON, fences, extra keys and bad classes without repairing them", () => {
    expect(validateAnswer("```json\n{}\n```", ids).malformed).toMatch(/not valid JSON/);
    expect(validateAnswer("{", ids).missing).toEqual(ids);
    expect(validateAnswer(JSON.stringify({ labels: [], extra: 1 }), ids).malformed).toMatch(/exactly/);
    expect(validateAnswer(ok([{ ...row("n1"), z: 1 }]), ids).malformed).toMatch(/labels\[0\]/);
    expect(validateAnswer(ok([row("n1", "X")]), ids).malformed).toMatch(/labels\[0\]/);
    expect(validateAnswer(ok([{ id: "n1", c: "M" }]), ids).malformed).toMatch(/labels\[0\]/); // u is required
  });
});
