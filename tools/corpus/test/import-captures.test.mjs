import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, contractId, sha256Of, validate } from "@gran-prix/contracts";
import * as features from "@gran-prix/features";
import { importCaptures, runImportCaptures } from "../src/import-captures.mjs";

const collect = new URL("../../cli/dist/stages/collect/", import.meta.url);
const { FLATTEN_SOURCE, htmlFileRef } = await import(new URL("flatten.js", collect).href);
const { htmlPath } = await import(new URL("snapshot-set.js", collect).href);

const root = mkdtempSync(join(tmpdir(), "gp-import-captures-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Real pages through the real probe (Chromium), packaged the way the extension packages them: snapshot json + html.gz. */
let captures; // { a, b, c }: { json: Buffer, gz: Buffer, snapshot, base }

async function capture(page, { host, title, text }) {
  await page.setContent(`<!doctype html><html lang="pt"><head><title>${title}</title></head><body><nav>menu</nav><main><h1>${title}</h1><p>${text}</p></main></body></html>`);
  const probed = await features.probeLoadedPage(page, { quietMs: 100, maxMs: 3000, networkIdleCapMs: 200 });
  const flat = await page.evaluate(FLATTEN_SOURCE);
  const html = htmlFileRef(htmlPath(sha256Of(flat.html)), flat.html);
  const raw = probed.raw;
  const url = `https://${host}/area/pagina`;
  const snapshot = features.buildPageSnapshot(
    { ...raw, page: { ...raw.page, url, final_url: url } },
    {
      url,
      category: "logged_in",
      group_key: host.split(".").slice(-2).join("."),
      html,
      capture: { collector_version: "gp-capture-ext/test", browser: { name: "chromium", version: "1.0.0.0" }, user_agent: "test", http_status: 200, captured_at: "2026-11-25T12:00:00.000Z" },
    },
  );
  const base = snapshot.snapshot_id.replace(/^sha256:/, "");
  return { base, snapshot, json: Buffer.from(`${canonicalJson(snapshot)}\n`), gz: gzipSync(Buffer.from(flat.html, "utf8")), html: flat.html };
}

beforeAll(async () => {
  const { browser, context } = await features.launch({ viewport: { width: 1000, height: 700 } });
  try {
    const page = await context.newPage();
    captures = {
      a: await capture(page, { host: "app.alpha.com", title: "Painel Alfa", text: "Conteúdo privado do app alfa com texto suficiente para existir." }),
      b: await capture(page, { host: "docs.beta.io", title: "Notas Beta", text: "Outro app, outro texto, também privado e também local." }),
      c: await capture(page, { host: "mail.alpha.com", title: "Caixa Alfa", text: "Segunda página do mesmo app alfa, para o aviso de um por app." }),
    };
  } finally {
    await context.close();
    await browser.close();
  }
}, 120_000);

function folder(name, pairs) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, bytes] of Object.entries(pairs)) writeFileSync(join(dir, file), bytes);
  return dir;
}
const pair = (c, base = c.base) => ({ [`${base}.json`]: c.json, [`${base}.html.gz`]: c.gz });

describe("import-captures: a valid folder", () => {
  it("builds a SnapshotSet in the collect layout, stratum logged_in, that its reader and the contract accept", async () => {
    const inDir = folder("valid-in", { ...pair(captures.a), ...pair(captures.b) });
    const out = join(root, "valid-out");
    const r = await importCaptures(inDir, out);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.imported.sort()).toEqual([captures.a.base, captures.b.base].sort());
    expect(r.apps).toEqual(["alpha.com", "beta.io"]);

    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.format).toBe("gran-prix.snapshot-set");
    expect(manifest.format_version).toBe("1.0.0");
    expect(manifest.failures).toEqual([]);
    expect(manifest.entries).toHaveLength(2);
    for (const e of manifest.entries) {
      expect(e.stratum).toBe("logged_in");
      expect(e.snapshot).toBe(`snapshots/${e.snapshot_id.replace(/^sha256:/, "")}.json`);
      expect(e.html).toMatch(/^html\/[0-9a-f]{64}\.html\.gz$/);
      const snap = JSON.parse(readFileSync(join(out, e.snapshot), "utf8"));
      expect(validate("page-snapshot", snap).ok).toBe(true);
      expect(e.node_count).toBe(snap.nodes.length);
      expect(e.group_key).toBe(snap.page.group_key);
      const { snapshot_id, ...body } = snap;
      expect(contractId("page-snapshot", body)).toBe(snapshot_id);
      expect(sha256Of(gunzipSync(readFileSync(join(out, e.html))).toString("utf8"))).toBe(snap.html.sha256);
      expect(snap.html.path).toBe(e.html);
    }
    expect(readdirSync(join(out, "snapshots"))).toHaveLength(2);
    expect(readdirSync(join(out, "html"))).toHaveLength(2);
  });

  it("is idempotent: the same folder again imports nothing and changes no byte", async () => {
    const inDir = join(root, "valid-in");
    const out = join(root, "valid-out");
    const before = readFileSync(join(out, "manifest.json"), "utf8");
    const r = await importCaptures(inDir, out);
    expect(r.ok).toBe(true);
    expect(r.imported).toEqual([]);
    expect(r.skipped).toHaveLength(2);
    expect(readFileSync(join(out, "manifest.json"), "utf8")).toBe(before);
  });

  it("extends an existing set and warns when two pages belong to the same app (protocol: one per app)", async () => {
    const out = join(root, "valid-out");
    const r = await importCaptures(folder("more-in", pair(captures.c)), out);
    expect(r.ok).toBe(true);
    expect(r.imported).toEqual([captures.c.base]);
    expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).entries).toHaveLength(3);
    expect(r.warnings.some((w) => w.startsWith("alpha.com: 2 páginas"))).toBe(true);
  });

  it("ignores hidden files and subfolders (the drop folder may hold an `imported/` directory)", async () => {
    const dir = folder("hidden-in", { ...pair(captures.b), ".DS_Store": "x" });
    mkdirSync(join(dir, "imported"));
    const r = await importCaptures(dir, join(root, "hidden-out"));
    expect(r.problems).toEqual([]);
    expect(r.imported).toEqual([captures.b.base]);
  });

  it("the CLI wrapper reports in Portuguese and returns 0", async () => {
    const lines = [];
    const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    const code = await runImportCaptures(folder("cli-in", pair(captures.a)), join(root, "cli-out"), log);
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^Importadas 1 captura\(s\) para /);
    expect(lines.join("\n")).toContain("Apps no conjunto (1;");
  });
});

describe("import-captures: refusals (nothing is written)", () => {
  const refuse = async (name, pairs, expectIn) => {
    const out = join(root, `${name}-out`);
    const r = await importCaptures(folder(`${name}-in`, pairs), out);
    expect(r.ok).toBe(false);
    expect(r.imported).toEqual([]);
    expect(r.problems.join("\n")).toContain(expectIn);
    expect(() => readdirSync(out)).toThrow(); // output folder was never created
    return r;
  };

  it("duplicate: the same snapshot under two names", async () => {
    const r = await refuse("dup", { ...pair(captures.a), ...pair(captures.a, "copia-de-a") }, "duplicado de");
    expect(r.problems).toHaveLength(1);
  });

  it("duplicate across runs: a different capture of a page that is already in the set is refused", async () => {
    const out = join(root, "recap-out");
    expect((await importCaptures(folder("recap-in1", pair(captures.a)), out)).ok).toBe(true);
    const later = { ...captures.a, snapshot: { ...captures.a.snapshot, capture: { ...captures.a.snapshot.capture, captured_at: "2026-11-26T00:00:00.000Z" } } };
    later.json = Buffer.from(`${canonicalJson(later.snapshot)}\n`);
    const r = await importCaptures(folder("recap-in2", pair(later)), out);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("o conjunto já tem este snapshot");
  });

  it("corrupted json", async () => {
    await refuse("badjson", { [`${captures.a.base}.json`]: Buffer.from('{"snap'), [`${captures.a.base}.html.gz`]: captures.a.gz }, "não é JSON");
  });

  it("json that is not a PageSnapshot", async () => {
    await refuse("notsnap", { "x.json": '{"hello":"world"}', "x.html.gz": captures.a.gz }, "não é um PageSnapshot válido");
  });

  it("wrong snapshot hash (a field edited after capture)", async () => {
    const edited = JSON.parse(captures.a.json.toString("utf8"));
    edited.nodes[1].own_text = "texto adulterado";
    const r = await refuse("badhash", { [`${captures.a.base}.json`]: JSON.stringify(edited), [`${captures.a.base}.html.gz`]: captures.a.gz }, "o hash do snapshot não confere");
    expect(r.problems[0]).toContain(captures.a.snapshot.snapshot_id);
  });

  it("wrong snapshot hash, edit that keeps the document otherwise valid (the title)", async () => {
    const edited = JSON.parse(captures.a.json.toString("utf8"));
    edited.page.title = "Outro título";
    await refuse("badhash2", { [`${captures.a.base}.json`]: JSON.stringify(edited), [`${captures.a.base}.html.gz`]: captures.a.gz }, "o hash do snapshot não confere");
  });

  it("wrong html hash (html.gz of another page)", async () => {
    await refuse("badhtml", { ...pair(captures.a), [`${captures.a.base}.html.gz`]: captures.b.gz }, "o hash do html não confere");
  });

  it("corrupted gzip", async () => {
    await refuse("badgz", { [`${captures.a.base}.json`]: captures.a.json, [`${captures.a.base}.html.gz`]: captures.a.gz.subarray(0, 20) }, "não é gzip");
  });

  it("missing counterpart, in both directions", async () => {
    await refuse("nogz", { [`${captures.a.base}.json`]: captures.a.json }, "faltando");
    await refuse("nojson", { [`${captures.a.base}.html.gz`]: captures.a.gz }, "faltando o");
  });

  it("a snapshot of another stratum", async () => {
    const other = JSON.parse(captures.a.json.toString("utf8"));
    other.page.category = "docs";
    const { snapshot_id: _drop, ...body } = other;
    other.snapshot_id = contractId("page-snapshot", body); // a valid, correctly hashed snapshot, just not a logged_in one
    await refuse("stratum", { "o.json": canonicalJson(other), "o.html.gz": captures.a.gz }, 'esperado "logged_in"');
  });

  it("unexpected files and empty folders, and a missing folder", async () => {
    await refuse("stray", { ...pair(captures.a), "notas.txt": "oi" }, "notas.txt: arquivo inesperado");
    await refuse("empty", {}, "nenhuma captura");
    expect((await importCaptures(join(root, "nao-existe"), join(root, "x-out"))).problems[0]).toContain("pasta não encontrada");
  });

  it("lists every problem of the run at once, and the CLI wrapper returns 1", async () => {
    const lines = [];
    const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    const code = await runImportCaptures(folder("many-in", { ...pair(captures.a), "lixo.txt": "x", [`${captures.b.base}.json`]: "{}" }), join(root, "many-out"), log);
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^Importação recusada: \d+ problema\(s\); nada foi gravado\.$/);
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });
});
