// `gp-corpus import-captures <pasta> --out <dir>`: turns the files the capture extension (tools/capture-extension)
// downloaded into a SnapshotSet of the stratum `logged_in`, in the exact layout the collect stage writes:
//
//   <out>/manifest.json            SnapshotSetManifest (entries carry stratum "logged_in": the Dataset reads it from here)
//   <out>/snapshots/<hex>.json     canonical JSON of each PageSnapshot
//   <out>/html/<hex>.html.gz       the flattened html, gzip level 9 like the collect stage (<hex> = sha256 of the DECODED html)
//
// Input: pairs `<base>.json` + `<base>.html.gz` (the extension names both after the snapshot hash). Nothing is written unless
// EVERY file is valid: the whole run is checked first and each problem is listed. Re-running over the same folder is
// harmless (identical captures already in the set are skipped); a different capture of a page already in the set is refused.
// Messages are in Portuguese: the person who runs this is the owner of the accounts.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { canonicalJson, contractId, sha256Of, validate } from "@gran-prix/contracts";

/** The collect stage's own layout helpers and gzip, from the built `@gran-prix/cli` (same convention as walk.mjs). */
async function loadCollectLib() {
  const dir = new URL("../../cli/dist/stages/collect/", import.meta.url);
  if (!existsSync(new URL("flatten.js", dir))) throw new Error("tools/cli is not built: run `pnpm -r build` first");
  const [{ SNAPSHOT_SET_FORMAT, snapshotPath, htmlPath }, { gzipHtml }] = await Promise.all([import(new URL("snapshot-set.js", dir).href), import(new URL("flatten.js", dir).href)]);
  return { SNAPSHOT_SET_FORMAT, snapshotPath, htmlPath, gzipHtml };
}

export const STRATUM = "logged_in";
const dec = new TextDecoder();

/** One line per problem: `<file>: <what is wrong>`. */
function checkPair(base, dir, lib) {
  const problems = [];
  const fail = (msg) => problems.push(`${base}.json: ${msg}`);
  const jsonPath = join(dir, `${base}.json`);
  const gzPath = join(dir, `${base}.html.gz`);

  let snapshot;
  try {
    snapshot = JSON.parse(dec.decode(readFileSync(jsonPath)));
  } catch (e) {
    fail(`arquivo corrompido, não é JSON (${e instanceof Error ? e.message : String(e)})`);
    return { problems };
  }
  const checked = validate("page-snapshot", snapshot);
  const hashIssue = !checked.ok && checked.issues.some((i) => i.path === "snapshot_id" && /does not match the hash/.test(i.message));
  if (hashIssue) {
    fail(`o hash do snapshot não confere (declarado ${snapshot.snapshot_id}): o arquivo foi alterado ou truncado depois da captura`);
    return { problems };
  }
  if (!checked.ok) {
    const first = checked.issues.slice(0, 3).map((i) => `${i.path || "(raiz)"}: ${i.message}`).join("; ");
    fail(`não é um PageSnapshot válido (${first}${checked.issues.length > 3 ? `; mais ${checked.issues.length - 3}` : ""})`);
    return { problems };
  }
  const { snapshot_id: declared, ...body } = snapshot;
  const recomputed = contractId("page-snapshot", body);
  if (recomputed !== declared) fail(`o hash do snapshot não confere (declarado ${declared}, recalculado ${recomputed}): o arquivo foi alterado ou truncado`);
  if (snapshot.page.category !== STRATUM) fail(`o estrato é "${snapshot.page.category}", esperado "${STRATUM}": esta captura não veio da extensão`);

  if (!existsSync(gzPath)) {
    problems.push(`${base}.html.gz: faltando; o .json referencia o html ${snapshot.html.sha256}`);
    return { problems, snapshot };
  }
  let html;
  try {
    html = dec.decode(gunzipSync(readFileSync(gzPath)));
  } catch (e) {
    problems.push(`${base}.html.gz: arquivo corrompido, não é gzip (${e instanceof Error ? e.message : String(e)})`);
    return { problems, snapshot };
  }
  if (sha256Of(html) !== snapshot.html.sha256) problems.push(`${base}.html.gz: o hash do html não confere (esperado ${snapshot.html.sha256}, calculado ${sha256Of(html)})`);
  else if (Buffer.byteLength(html, "utf8") !== snapshot.html.bytes) problems.push(`${base}.html.gz: o tamanho do html não confere (esperado ${snapshot.html.bytes} bytes)`);
  if (snapshot.html.path !== lib.htmlPath(snapshot.html.sha256)) fail(`o caminho do html no snapshot (${snapshot.html.path}) não segue o layout do conjunto`);
  return { problems, snapshot, html };
}

/**
 * @param {string} inDir folder with the downloaded files
 * @param {string} outDir SnapshotSet directory to create or extend
 * @returns {Promise<{ ok: boolean, problems: string[], warnings: string[], imported: string[], skipped: string[], apps: string[] }>}
 */
export async function importCaptures(inDir, outDir) {
  const lib = await loadCollectLib();
  const problems = [];
  const warnings = [];
  if (!existsSync(inDir) || !statSync(inDir).isDirectory()) return { ok: false, problems: [`${inDir}: pasta não encontrada`], warnings, imported: [], skipped: [], apps: [] };

  const names = readdirSync(inDir).filter((n) => !n.startsWith(".") && statSync(join(inDir, n)).isFile()).sort();
  const bases = new Set();
  for (const n of names) {
    if (n.endsWith(".html.gz")) bases.add(n.slice(0, -".html.gz".length));
    else if (n.endsWith(".json")) bases.add(n.slice(0, -".json".length));
    else problems.push(`${n}: arquivo inesperado (esperado .json ou .html.gz da extensão)`);
  }
  if (bases.size === 0 && problems.length === 0) problems.push(`${inDir}: nenhuma captura (.json + .html.gz) encontrada`);

  const found = [];
  for (const base of [...bases].sort()) {
    if (!names.includes(`${base}.json`)) {
      problems.push(`${base}.html.gz: faltando o ${base}.json correspondente`);
      continue;
    }
    const got = checkPair(base, inDir, lib);
    problems.push(...got.problems);
    if (got.snapshot && got.html !== undefined && got.problems.length === 0) found.push({ base, snapshot: got.snapshot, html: got.html });
  }

  // Duplicates inside the folder: the same snapshot (same page, same DOM) under two names.
  const byId = new Map();
  for (const f of found) {
    const prev = byId.get(f.snapshot.snapshot_id);
    if (prev) problems.push(`${f.base}.json: duplicado de ${prev.base}.json (mesmo snapshot ${f.snapshot.snapshot_id}); apague um dos dois`);
    else byId.set(f.snapshot.snapshot_id, f);
  }

  // What is already in the output set.
  const manifestPath = join(outDir, "manifest.json");
  let manifest = { format: lib.SNAPSHOT_SET_FORMAT, format_version: "1.0.0", entries: [], failures: [] };
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e) {
      problems.push(`${manifestPath}: manifest ilegível (${e instanceof Error ? e.message : String(e)})`);
    }
    if (manifest.format !== lib.SNAPSHOT_SET_FORMAT) problems.push(`${manifestPath}: não é um SnapshotSet (format ${JSON.stringify(manifest.format)})`);
  }
  const existing = new Map((manifest.entries ?? []).map((e) => [e.snapshot_id, e]));
  const toWrite = [];
  const skipped = [];
  for (const f of byId.values()) {
    const prior = existing.get(f.snapshot.snapshot_id);
    if (!prior) {
      toWrite.push(f);
      continue;
    }
    const stored = join(outDir, prior.snapshot);
    if (existsSync(stored) && readFileSync(stored, "utf8") === `${canonicalJson(f.snapshot)}\n`) skipped.push(f.base);
    else problems.push(`${f.base}.json: o conjunto já tem este snapshot (${f.snapshot.snapshot_id}) com outra captura; recusado. Para trocar, apague a entrada antiga do conjunto`);
  }

  if (problems.length > 0) return { ok: false, problems, warnings, imported: [], skipped, apps: [] };

  toWrite.sort((a, b) => (a.snapshot.snapshot_id < b.snapshot.snapshot_id ? -1 : 1));
  const entries = [...(manifest.entries ?? [])];
  for (const f of toWrite) {
    const s = f.snapshot;
    const snapRel = lib.snapshotPath(s.snapshot_id);
    for (const rel of [snapRel, s.html.path]) mkdirSync(join(outDir, rel, ".."), { recursive: true });
    writeFileSync(join(outDir, snapRel), `${canonicalJson(s)}\n`);
    writeFileSync(join(outDir, s.html.path), lib.gzipHtml(f.html));
    entries.push({
      snapshot_id: s.snapshot_id,
      url: s.page.url,
      final_url: s.page.final_url,
      stratum: STRATUM,
      group_key: s.page.group_key,
      http_status: s.capture.http_status,
      flags: s.capture.flags ?? [],
      node_count: s.nodes.length,
      snapshot: snapRel,
      html: s.html.path,
    });
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(manifestPath, `${canonicalJson({ ...manifest, format: lib.SNAPSHOT_SET_FORMAT, format_version: "1.0.0", entries, failures: manifest.failures ?? [] })}\n`);

  const perApp = new Map();
  for (const e of entries) perApp.set(e.group_key, (perApp.get(e.group_key) ?? 0) + 1);
  for (const [app, n] of perApp) if (n > 1) warnings.push(`${app}: ${n} páginas no conjunto; o protocolo (§2.5) pede 1 por app`);
  for (const e of entries) if (e.flags.length > 0) warnings.push(`${e.url}: avisos da captura (${e.flags.join(", ")}); confira se é a página certa`);
  return { ok: true, problems, warnings, imported: toWrite.map((f) => f.base), skipped, apps: [...perApp.keys()].sort() };
}

/** CLI wrapper: prints in Portuguese, returns the process exit code. */
export async function runImportCaptures(inDir, outDir, log = console) {
  const r = await importCaptures(inDir, outDir);
  if (!r.ok) {
    log.error(`Importação recusada: ${r.problems.length} problema(s); nada foi gravado.`);
    for (const p of r.problems) log.error(`  - ${p}`);
    return 1;
  }
  log.log(`Importadas ${r.imported.length} captura(s) para ${outDir}${r.skipped.length > 0 ? `; ${r.skipped.length} já estava(m) no conjunto` : ""}.`);
  log.log(`Apps no conjunto (${r.apps.length}; o protocolo pede ≥ 10, alvo 12): ${r.apps.join(", ")}`);
  for (const w of r.warnings) log.log(`  aviso: ${w}`);
  return 0;
}
