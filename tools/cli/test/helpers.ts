import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineSpec } from "@gran-prix/contracts";
import { DEMO_STAGES, type StagePlugin, type Io } from "../src/index.js";

const made: string[] = [];

export function tmpDir(prefix = "gp-cli-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

export function cleanupTmp(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Demo plugins that count how many times each stage's `run` was actually invoked. */
export function countingPlugins(): { plugins: StagePlugin[]; calls: Map<string, number>; reset(): void } {
  const calls = new Map<string, number>();
  const plugins = DEMO_STAGES.map(
    (p): StagePlugin => ({
      spec: p.spec,
      run: (ctx) => {
        calls.set(ctx.stageId, (calls.get(ctx.stageId) ?? 0) + 1);
        return p.run(ctx);
      },
    }),
  );
  return { plugins, calls, reset: () => calls.clear() };
}

const ENV = { format: "gran-prix.pipeline-spec", format_version: "1.0.0" } as const;

/**
 *   emit_a --\
 *             join --> label (paid) --> tail
 *   emit_b --/
 *   side (independent branch)
 */
export function demoSpec(over: { a?: string; b?: string; sep?: string; price?: number; calls?: number } = {}): PipelineSpec {
  return {
    ...ENV,
    name: "test-demo",
    vars: { sep: over.sep ?? "-", price: over.price ?? 0.25 },
    stages: [
      { id: "emit_a", kind: "collect", impl: "ts:demo.emit-json@1.0.0", params: { value: over.a ?? "alpha" }, inputs: {} },
      { id: "emit_b", kind: "collect", impl: "ts:demo.emit-json@1.0.0", params: { value: over.b ?? "beta" }, inputs: {} },
      {
        id: "join",
        kind: "extract",
        impl: "ts:demo.concat@1.0.0",
        params: { separator: "${vars.sep}" },
        inputs: { parts: [{ stage: "emit_a", output: "out" }, { stage: "emit_b", output: "out" }] },
      },
      {
        id: "label",
        kind: "label",
        impl: "ts:demo.spend@1.0.0",
        params: { cost_usd: "${vars.price}", calls: over.calls ?? 2 },
        inputs: { in: { stage: "join", output: "out" } },
      },
      {
        id: "tail",
        kind: "extract",
        impl: "ts:demo.concat@1.0.0",
        params: {},
        inputs: { parts: [{ stage: "emit_a", output: "out" }] },
      },
      { id: "side", kind: "collect", impl: "ts:demo.emit-json@1.0.0", params: { value: 1 }, inputs: {} },
    ],
  };
}

/** Captured Io for driving `main`. */
export function captureIo(cwd: string, env: Record<string, string> = {}): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { out: (l) => stdout.push(l), err: (l) => stderr.push(l), cwd, env, stdout, stderr };
}
