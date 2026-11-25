import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactId, sha256Of } from "@gran-prix/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore, dependenciesOf, select, topologicalOrder } from "../src/index.js";
import { cleanupTmp, demoSpec, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

describe("ArtifactStore", () => {
  it("JSON artifacts are content-addressed by their canonical hash and deduplicated", () => {
    const s = new ArtifactStore(join(tmpDir(), "artifacts"));
    const id = s.putJson("Bundle", { b: 1, a: [1, 2] });
    expect(id).toBe(artifactId({ a: [1, 2], b: 1 })); // key order does not matter
    expect(s.putJson("Bundle", { a: [1, 2], b: 1 })).toBe(id);
    expect(readdirSync(s.root).filter((n) => n.startsWith("sha256-"))).toEqual([id.replace(":", "-")]);
    expect(s.handle(id, "Bundle").json()).toEqual({ a: [1, 2], b: 1 });
    expect(s.verify(id)).toBe(true);
  });

  it("file-set artifacts hash path and bytes; binaries are hashed raw", () => {
    const s = new ArtifactStore(join(tmpDir(), "artifacts"));
    const w = new Uint8Array([1, 2, 3, 250]);
    const a = s.putFiles("Bundle", { "weights.f32le": w, "notes/readme.txt": "hi" });
    const b = s.putFiles("Bundle", { "notes/readme.txt": "hi", "weights.f32le": w });
    const c = s.putFiles("Bundle", { "notes/readme.txt": "hi", "weights.f32le": new Uint8Array([1, 2, 3, 251]) });
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    const h = s.handle(a, "Bundle");
    expect(h.files()).toEqual(["notes/readme.txt", "weights.f32le"]);
    expect(sha256Of(h.file("weights.f32le"))).toBe(sha256Of(w));
    expect(s.verify(a)).toBe(true);
  });

  it("verify detects tampering", () => {
    const s = new ArtifactStore(join(tmpDir(), "artifacts"));
    const id = s.putJson("Bundle", { x: 1 });
    writeFileSync(join(s.dirOf(id), "content.json"), '{"x":2}\n');
    expect(s.verify(id)).toBe(false);
  });

  it("rejects file paths that escape the artifact", () => {
    const s = new ArtifactStore(join(tmpDir(), "artifacts"));
    for (const bad of ["../x", "/abs", "a//b", "a/../b", ""]) {
      expect(() => s.putFiles("Bundle", { [bad]: "x" })).toThrow(/invalid artifact file path/);
    }
  });

  it("refuses non-canonicalizable JSON (NaN) instead of storing something unhashable", () => {
    const s = new ArtifactStore(join(tmpDir(), "artifacts"));
    expect(() => s.putJson("Bundle", { x: Number.NaN })).toThrow();
    expect(existsSync(s.root)).toBe(false); // nothing was written, not even a temp dir
  });

  it("resolves unique id prefixes", () => {
    const s = new ArtifactStore(join(tmpDir(), "artifacts"));
    const id = s.putJson("Bundle", { x: 1 });
    expect(s.resolve(id.slice(0, 15))).toBe(id);
    expect(s.resolve(id.replace("sha256:", "sha256-").slice(0, 14))).toBe(id);
    expect(() => s.resolve("sha256:ffff")).toThrow(/no artifact/);
    expect(() => s.resolve("zz")).toThrow(/not an artifact id/);
  });
});

describe("graph", () => {
  it("orders stages topologically, ties broken by declaration order", () => {
    expect(topologicalOrder(demoSpec())).toEqual(["emit_a", "emit_b", "join", "label", "tail", "side"]);
    const spec = demoSpec();
    spec.stages.reverse(); // dependents declared first
    const order = topologicalOrder(spec);
    expect(order.indexOf("emit_a")).toBeLessThan(order.indexOf("join"));
    expect(order.indexOf("join")).toBeLessThan(order.indexOf("label"));
  });

  it("dependenciesOf lists upstream stage ids once, ignoring externals", () => {
    const join = demoSpec().stages[2];
    expect(join && dependenciesOf(join)).toEqual(["emit_a", "emit_b"]);
  });

  it("select: active = downstream of --from and upstream of --to; their other ancestors are frozen", () => {
    const spec = demoSpec();
    const sel = (f?: string, t?: string) => {
      const r = select(spec, f, t);
      return { active: [...r.active].sort(), frozen: [...r.frozen].sort() };
    };
    expect(sel().frozen).toEqual([]);
    expect(sel("join")).toEqual({ active: ["join", "label"], frozen: ["emit_a", "emit_b"] });
    expect(sel(undefined, "join")).toEqual({ active: ["emit_a", "emit_b", "join"], frozen: [] });
    expect(sel("label", "label")).toEqual({ active: ["label"], frozen: ["emit_a", "emit_b", "join"] });
    expect(sel("side")).toEqual({ active: ["side"], frozen: [] });
    expect(() => select(spec, "nope")).toThrow(/no such stage/);
  });
});
