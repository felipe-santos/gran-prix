import { canonicalJson } from "@gran-prix/contracts";
import { defineStage, type StageContext } from "../stage.js";
import type { ArtifactHandle } from "../store.js";
import { capturePage, CaptureError, type FeaturesModule } from "./collect/capture.js";
import { SNAPSHOT_SET_FORMAT, type SnapshotSetEntry, type SnapshotSetFailure, type SnapshotSetManifest } from "./collect/snapshot-set.js";
import { resolveTarget } from "./collect/target.js";
import { parseUrlList } from "./collect/url-list.js";
import { resolve } from "node:path";

/**
 * `ts:collect.playwright@1.0.0`: UrlList -> SnapshotSet.
 *
 * One Chromium (headless), one fresh browser context per page, pages captured sequentially (background
 * tabs get throttled timers, which would distort the DOM-quiet window). Per page: load, best-effort
 * networkidle, DOM-quiet settle, stamp `data-gp-id`, probe (@gran-prix/features), flattened gzip html,
 * contract-valid PageSnapshot. Layout of the output: see `collect/snapshot-set.ts`.
 *
 * `determinism: "external"`: the live web changes. After capture everything is content addressed; the
 * volatile capture data (`captured_at`, settle timings) lives in `capture`, outside `snapshot_id`, and
 * `captured_at` can be pinned so that a re-collect of an unchanged page yields the same SnapshotSet id.
 */
export const collect = defineStage(
  {
    kind: "collect",
    impl: "ts:collect.playwright@1.0.0",
    inputs: [{ name: "urls", type: "UrlList" }],
    outputs: [{ name: "snapshots", type: "SnapshotSet" }],
    params_schema: {
      type: "object",
      required: ["viewport"],
      properties: {
        viewport: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 2, maxItems: 2, description: "[width, height] in CSS pixels." },
        wait: { type: "string", description: "Free-text note appended to capture.wait_strategy; the real strategy is set by `settle`." },
        max_nodes: { type: "integer", minimum: 1, description: "Pages with more elements are not snapshotted; they are listed in manifest.failures (reason max_nodes)." },
        settle: {
          type: "object",
          properties: {
            quiet_ms: { type: "integer", minimum: 0, description: "DOM-quiet window, default 600." },
            max_ms: { type: "integer", minimum: 0, description: "Hard cap of the quiet wait, default 8000." },
            network_idle_cap_ms: { type: "integer", minimum: 0, description: "Cap of the best-effort networkidle wait, default 3000." },
          },
          additionalProperties: false,
        },
        nav_timeout_ms: { type: "integer", minimum: 1, description: "Timeout of the navigation (load event), default 30000." },
        base_dir: { type: "string", description: "Directory that relative file paths of the UrlList resolve against; default = the run root (the working directory)." },
        captured_at: { type: "string", description: "RFC 3339 timestamp to store instead of the clock (reproducible set ids)." },
        private_suffixes: { type: "boolean", description: "Treat private public-suffix entries (github.io, blogspot.com) as suffixes when computing group_key; default true." },
        fail_on_error: { type: "boolean", description: "Fail the stage when any page could not be snapshotted; default false (failures are listed in the manifest and logged)." },
      },
    },
    runtime: "node+playwright",
    determinism: "external",
    map_over: "group",
  },
  async (ctx) => {
    const p = readParams(ctx);
    const entries = parseUrlList(ctx.inputs["urls"] as ArtifactHandle);
    const features: FeaturesModule = await import("@gran-prix/features");
    const bundle = features.bundleSource();
    const { browser, context: first } = await features.launch({ viewport: { width: p.viewport[0], height: p.viewport[1] } });
    await first.close();

    const files: Record<string, Uint8Array | string> = {};
    const manifestEntries: SnapshotSetEntry[] = [];
    const failures: SnapshotSetFailure[] = [];
    try {
      for (const entry of entries) {
        try {
          const target = (() => {
            try {
              return resolveTarget(entry, p.baseDir);
            } catch (e) {
              throw new CaptureError("bad_url", e instanceof Error ? e.message : String(e));
            }
          })();
          const got = await capturePage(browser, entry, target, {
            features,
            bundle,
            viewport: { width: p.viewport[0], height: p.viewport[1] },
            quietMs: p.quietMs,
            maxMs: p.maxMs,
            networkIdleCapMs: p.networkIdleCapMs,
            navTimeoutMs: p.navTimeoutMs,
            maxNodes: p.maxNodes,
            capturedAt: p.capturedAt,
            waitLabel: p.wait,
            privateSuffixes: p.privateSuffixes,
          });
          Object.assign(files, got.files);
          manifestEntries.push(got.entry);
          ctx.log(`${entry.url} [${entry.stratum}] -> ${got.entry.snapshot_id.slice(0, 15)}: ${got.note}`);
        } catch (e) {
          const reason = e instanceof CaptureError ? e.reason : "capture";
          const message = e instanceof Error ? e.message : String(e);
          failures.push({ url: entry.url, stratum: entry.stratum, reason, message });
          ctx.log(`${entry.url} FAILED (${reason}): ${message}`);
        }
      }
    } finally {
      await browser.close();
    }

    if (manifestEntries.length === 0) throw new Error(`collect: no page could be snapshotted (${failures.map((f) => `${f.url}: ${f.message}`).join("; ")})`);
    if (p.failOnError && failures.length > 0) throw new Error(`collect: ${failures.length} of ${entries.length} page(s) failed: ${failures.map((f) => `${f.url} (${f.reason}: ${f.message})`).join("; ")}`);

    const manifest: SnapshotSetManifest = { format: SNAPSHOT_SET_FORMAT, format_version: "1.0.0", entries: manifestEntries, failures };
    files["manifest.json"] = `${canonicalJson(manifest)}\n`;
    return { snapshots: { files } };
  },
);

interface Params {
  viewport: [number, number];
  wait: string | undefined;
  maxNodes: number | undefined;
  quietMs: number;
  maxMs: number;
  networkIdleCapMs: number;
  navTimeoutMs: number;
  baseDir: string;
  capturedAt: string | undefined;
  privateSuffixes: boolean;
  failOnError: boolean;
}

/** `params` is already validated against `params_schema`; this only applies defaults. */
function readParams(ctx: StageContext): Params {
  const raw = ctx.params;
  const settle = (raw["settle"] ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number): number => (typeof v === "number" ? v : d);
  const vp = raw["viewport"] as number[];
  // `StageContext` has no run root yet (proposed: `ctx.root`); until then relative paths resolve against the
  // working directory, which is the run root unless `gp run --root` points elsewhere (then set `base_dir`).
  const root = (ctx as StageContext & { readonly root?: string }).root ?? process.cwd();
  const capturedAt = raw["captured_at"];
  if (typeof capturedAt === "string" && Number.isNaN(Date.parse(capturedAt))) throw new Error(`collect: captured_at ${JSON.stringify(capturedAt)} is not an RFC 3339 timestamp`);
  return {
    viewport: [vp[0] as number, vp[1] as number],
    wait: typeof raw["wait"] === "string" ? raw["wait"] : undefined,
    maxNodes: typeof raw["max_nodes"] === "number" ? raw["max_nodes"] : undefined,
    quietMs: num(settle["quiet_ms"], 600),
    maxMs: num(settle["max_ms"], 8000),
    networkIdleCapMs: num(settle["network_idle_cap_ms"], 3000),
    navTimeoutMs: num(raw["nav_timeout_ms"], 30_000),
    baseDir: resolve(root, typeof raw["base_dir"] === "string" ? raw["base_dir"] : "."),
    capturedAt: typeof capturedAt === "string" ? capturedAt : undefined,
    privateSuffixes: raw["private_suffixes"] !== false,
    failOnError: raw["fail_on_error"] === true,
  };
}
