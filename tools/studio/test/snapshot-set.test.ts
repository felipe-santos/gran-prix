import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contractId, type PageSnapshot } from "@gran-prix/contracts";
import { afterAll, describe, expect, inject, it } from "vitest";
import { PageCache } from "../src/server/pages.js";
import { listArtifacts, listPages, safeRel } from "../src/server/snapshot-set.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

describe("reading the artifact store", () => {
  it("finds the SnapshotSet pages of a data dir, in manifest order, and skips non-artifacts", () => {
    const dir = tmpDir();
    cpSync(inject("corpusDataDir"), dir, { recursive: true });
    mkdirSync(join(dir, "artifacts", ".tmp-1234-ab"), { recursive: true }); // a running writer's temp dir
    mkdirSync(join(dir, "artifacts", "sha256-halfwritten"), { recursive: true }); // no meta.json yet
    const pages = listPages(dir);
    expect(pages.map((p) => p.entry.stratum)).toEqual(["article", "product"]);
    expect(listArtifacts(dir, "SnapshotSet")).toHaveLength(1);
    expect(listArtifacts(join(dir, "nothing-here"), "SnapshotSet")).toEqual([]);
  });

  it("safeRel accepts artifact-relative paths and rejects traversal", () => {
    expect(safeRel("html/ab.html.gz")).toBe("html/ab.html.gz");
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "a//b", "a\\b", "", "./x", "a/\0b", 3, null]) expect(() => safeRel(bad), String(bad)).toThrow(/unsafe/);
  });

  it("a snapshot that is not contract-valid becomes an error, not a crash (the id is recomputed)", () => {
    const dir = tmpDir();
    cpSync(inject("corpusDataDir"), dir, { recursive: true });
    const ref = listPages(dir)[0]!;
    const file = join(ref.filesDir, ref.entry.snapshot);
    const doc = JSON.parse(readFileSync(file, "utf8")) as PageSnapshot;
    doc.nodes[3]!.tag = "tampered";
    writeFileSync(file, JSON.stringify(doc));
    expect(() => new PageCache().load(ref)).toThrow(/not a valid PageSnapshot/);
  });
});

describe("disclosure flag (contracts v1.1)", () => {
  it("puts collapsed-disclosure content in U even though it is not rendered", () => {
    const dir = tmpDir();
    cpSync(inject("corpusDataDir"), dir, { recursive: true });
    const ref = listPages(dir)[0]!; // article-1, with the display:none #subscribe-modal
    const cache = new PageCache();
    const before = cache.load(ref);
    const modal = before.snapshot.nodes.find((n) => n.attrs.id === "subscribe-modal")!;
    expect(before.nodes.filter((n) => n.u !== 0).length).toBe(before.model.units.length);
    expect(before.nodes[modal.idx + 1]!.u).toBe(0); // its h2 is not rendered: out of U

    // a collector that recorded the modal as a collapsed disclosure: flag its subtree, re-address the snapshot
    const doc = structuredClone(before.snapshot);
    const end = modal.idx + before.model.size[modal.idx]!;
    for (let i = modal.idx; i < end; i++) doc.nodes[i]!.flags.disclosure = true;
    doc.snapshot_id = contractId("page-snapshot", doc as unknown as Record<string, unknown>);
    const hex = doc.snapshot_id.slice("sha256:".length);
    writeFileSync(join(ref.filesDir, "snapshots", `${hex}.json`), JSON.stringify(doc));
    const manifestPath = join(ref.filesDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    Object.assign(manifest.entries[0], { snapshot_id: doc.snapshot_id, snapshot: `snapshots/${hex}.json` });
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const after = new PageCache().load(listPages(dir)[0]!);
    const h2 = after.nodes[modal.idx + 1]!;
    expect(h2.t).toBe("h2");
    expect(h2.u).toBe(2); // disclosure unit
    expect(after.model.units.length).toBe(before.model.units.length + 2); // the modal's h2 and p
  });
});

describe("the shared SnapshotSetReader (debt b)", () => {
  it("is the class the cli exports, and the pages of the Studio are read through it", async () => {
    const cli = await import("@gran-prix/cli");
    const labels = await import("@gran-prix/labels");
    expect(cli.SnapshotSetReader).toBe(labels.SnapshotSetReader);
    const dir = tmpDir();
    cpSync(inject("corpusDataDir"), dir, { recursive: true });
    const refs = listPages(dir);
    expect(refs).toHaveLength(2);
    for (const ref of refs) {
      expect(ref.reader).toBeInstanceOf(cli.SnapshotSetReader);
      expect(ref.reader.entries()).toContainEqual(ref.entry);
      expect(ref.reader.snapshot(ref.entry).snapshot_id).toBe(ref.entry.snapshot_id);
      expect(ref.reader.html(ref.entry)).toContain("data-gp-id=");
    }
    // a path outside the artifact is refused by the file source, not read
    expect(() => refs[0]!.reader.snapshot({ snapshot: "../../meta.json" })).toThrow(/unsafe/);
  });
});
