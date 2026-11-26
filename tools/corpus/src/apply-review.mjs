// `gp-corpus apply-review <export.json>`: applies the owner's review (the JSON exported by review.html) BY RULE.
//   1. validates the export (same lock, every page in the corpus, no duplicates, known answers and reasons);
//   2. for each page answered `nao` or `duvida`, appends a record that supersedes the accepted one (`outcome: excluded`,
//      `reason: owner-review:<motivo>`); walked.jsonl stays append-only, the trail is kept;
//   3. replaces by the rule of §2.2/§2.3.2: the whole walk is replayed in `order_hash` order, so the corpus is the one that would
//      have come out if the review had existed during the walk (replay.mjs): recorded evaluations are reused unless they depend on the
//      state (domain/pt-es quotas, the SPA fallback pool); a candidate barred only by a quota that is free now is fetched now, with
//      the same code, rules and user agent; only after the recorded ones does the walk go on to unvisited candidates;
//   4. rewrites urls.csv / summary.json / split-check.txt / ..., writes review-applied.md and a NEW lock (`corpus-v0.1.lock.json`)
//      with `supersedes` (sha256 of the lock it replaces) and the sha256 of the export. The old lock is never deleted.
// Idempotent: the same export a second time changes nothing. Resumable: a crash after the exclusions were written is finished
// by running the same command again.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CATEGORIES } from "./config.mjs";
import { readJsonlSync } from "./jsonl.mjs";
import { LOCKED_FILES, archiveDirOf, createLock, latestLock, listLocks, lockNameOf, sha256File, verifyLock } from "./lock.mjs";
import { writeOutputs } from "./report.mjs";
import { ANSWERS, EXCLUDING, NO_REASON, REASON_VALUES, REVIEW_FORMAT } from "./review-format.mjs";
import { AMENDED_MINIMA, firstSalt, splitCheck } from "./split.mjs";
import { OWNER_REVIEW_PREFIX, effectiveRecords, targetOf } from "./state.mjs";
import { replayWalk } from "./replay.mjs";
import { Collector } from "./walk.mjs";

/** Files `apply-review` rewrites that the superseded lock froze or that describe it: kept in `archive/<lock name>/`. */
const ARCHIVED = [...LOCKED_FILES.filter((f) => f !== "frame.jsonl"), "summary.json", "split-check.txt", "review-applied.md"];

const keyOf = (category, url) => `${category}|${url}`;
const sha256Bytes = (buf) => `sha256:${createHash("sha256").update(buf).digest("hex")}`;
const cell = (s) => String(s ?? "").replace(/\|/g, "%7C").replace(/\s+/g, " ").trim();

/**
 * Pure validation of an export against the effective records frozen by the lock in force.
 * Returns {errors, exclusions, kept, unreviewed, ignored_checks}; `exclusions` = [{rec, answer, reason, reason_text, note}] in
 * corpus order. Nothing is partially valid: any error means nothing is applied.
 */
export function validateReview(exp, { lockSha, records }) {
  const errors = [];
  if (exp === null || typeof exp !== "object" || Array.isArray(exp)) return { errors: ["the export is not a JSON object"], exclusions: [], kept: 0, unreviewed: [], ignored_checks: [] };
  if (exp.format !== REVIEW_FORMAT) errors.push(`format is ${JSON.stringify(exp.format)}, expected ${REVIEW_FORMAT}`);
  if (exp.lock_sha256 !== lockSha) errors.push(`the review was made over lock ${exp.lock_sha256 ?? "(none)"}, the lock in force is ${lockSha}: another corpus`);
  if (!Array.isArray(exp.pages)) errors.push("pages is not an array");
  const accepted = new Map(records.filter((r) => r.outcome === "accepted").map((r) => [keyOf(r.category, r.url), r]));
  const seen = new Set();
  const exclusions = [];
  let kept = 0;
  for (const [i, p] of (Array.isArray(exp.pages) ? exp.pages : []).entries()) {
    const where = `pages[${i}]`;
    if (p === null || typeof p !== "object") {
      errors.push(`${where}: not an object`);
      continue;
    }
    const k = keyOf(p.category, p.url);
    const rec = accepted.get(k);
    if (!rec) {
      errors.push(`${where}: ${p.category}|${p.url} is not an accepted page of the corpus`);
      continue;
    }
    if (seen.has(k)) {
      errors.push(`${where}: duplicate page ${k}`);
      continue;
    }
    seen.add(k);
    if (p.snapshot_id !== rec.set_entry?.snapshot_id) errors.push(`${where}: snapshot_id ${p.snapshot_id} does not match the corpus (${rec.set_entry?.snapshot_id}) for ${p.url}`);
    if (!ANSWERS.includes(p.answer)) {
      errors.push(`${where}: answer ${JSON.stringify(p.answer)} is not one of ${ANSWERS.join("/")} (${p.url})`);
      continue;
    }
    if (!EXCLUDING.has(p.answer)) {
      kept++;
      continue;
    }
    const reason = p.reason ?? "";
    if (reason !== "" && !REASON_VALUES.has(reason)) errors.push(`${where}: unknown reason ${JSON.stringify(reason)} (${p.url})`);
    for (const f of ["reason_text", "note"]) if (p[f] !== undefined && typeof p[f] !== "string") errors.push(`${where}: ${f} must be a string`);
    exclusions.push({ rec, answer: p.answer, reason: reason === "" ? NO_REASON : reason, reason_text: p.reason_text ?? "", note: p.note ?? "" });
  }
  exclusions.sort((a, b) => a.rec.seq - b.rec.seq);
  const unreviewed = [...accepted.entries()].filter(([k]) => !seen.has(k)).map(([, r]) => r);
  const ignored_checks = Array.isArray(exp.exclusion_checks) ? exp.exclusion_checks.filter((c) => c?.answer === "nao" || c?.answer === "duvida") : [];
  return { errors, exclusions, kept, unreviewed, ignored_checks };
}

/** The exclusion record that supersedes an accepted one. Keeps the evidence (`detail`, `screenshot`); the old record stays in the file. */
export function exclusionRecord(ex, seq, { exportSha, lockSha, now }) {
  const o = ex.rec;
  return {
    seq,
    category: o.category,
    walk_category: o.walk_category,
    phase: o.phase,
    url: o.url,
    order_hash: o.order_hash,
    domain: o.domain,
    source_dataset: o.source_dataset,
    source_type: o.source_type,
    outcome: "excluded",
    reason: `${OWNER_REVIEW_PREFIX}${ex.reason}`,
    supersedes: o.seq,
    detail: o.detail,
    screenshot: o.screenshot,
    review: { answer: ex.answer, reason: ex.reason, reason_text: ex.reason_text, note: ex.note, export_sha256: exportSha, lock_sha256: lockSha },
    at: now.toISOString(),
  };
}

const maxSeq = (rows) => Math.max(0, ...rows.map((r) => r.seq ?? 0));
const groupKeyOf = (r) => r.detail?.group_key ?? r.domain;
const domainTotal = (records, d) => records.filter((r) => r.outcome === "accepted" && groupKeyOf(r) === d).length;

/** The two readings of the §3 rule for a set of pages: the pre-registered one and the amended one (SPA minima). */
export function saltSummary(records) {
  const pages = records.filter((r) => r.outcome === "accepted").map((r) => ({ category: r.category, group_key: r.detail.group_key }));
  const pre = firstSalt(pages);
  const am = firstSalt(pages, 1000, undefined, true);
  const fmt = (x) => (x.i === null ? "nenhum" : `i = ${x.i} (${x.salt})`);
  return { pages: pages.length, pre: fmt(pre), amended: fmt(am), pre_i: pre.i, amended_i: am.i, amended_counts: am.counts };
}

/**
 * What changed between the frozen records and the records after the replay, read from the records themselves (so a resumed run
 * reports the same as a clean one): pages that entered (with why) and pages the replay displaced (accepted before, refused now).
 */
export function describeChanges(records0, records1, allRecords) {
  const bySeq = new Map(allRecords.map((r) => [r.seq, r]));
  const had = new Set(records0.filter((r) => r.outcome === "accepted").map((r) => keyOf(r.category, r.url)));
  const entered = records1
    .filter((r) => r.outcome === "accepted" && !had.has(keyOf(r.category, r.url)))
    .sort((a, b) => a.seq - b.seq)
    .map((rec) => {
      const old = rec.supersedes === undefined ? null : bySeq.get(rec.supersedes);
      return old
        ? { rec, reopened: true, why: `reaberta: estava excluída por \`${old.reason}\` (#${old.seq}), que dependia do estado; a vaga ficou livre e ela foi buscada agora, na posição dela` }
        : { rec, reopened: false, why: "primeira candidata sem registro anterior, na ordem de hash" };
    });
  const displaced = records1
    .filter((r) => r.replay?.kind === "displaced")
    .sort((a, b) => a.seq - b.seq)
    .map((rec) => ({ rec, why: rec.reason === "replay:target-reached" ? "a categoria fechou o alvo antes dela na ordem" : "a vaga foi tomada por uma candidata reaberta mais cedo na ordem" }));
  return { entered, displaced };
}

/** review-applied.md. A pure function of what happened. */
export function buildReport({ now, exportSha, exportedAt, oldLock, oldLockSha, newLockName, before, after, exclusions, entered, displaced, visitedExcluded, unreviewed, kept, ignored, saltBefore, saltAfter, shortfalls }) {
  const L = [];
  const catRow = (c) => `| ${c.name} | ${before.filter((r) => r.category === c.name).length} | ${after.filter((r) => r.category === c.name).length} | ${c.n} |`;
  L.push("# Revisão do dono aplicada ao corpus dom-v0", "");
  L.push(`Aplicada em ${now.toISOString()}. Arquivo local, fora do git (data dir).`, "");
  L.push(`- export: \`${exportSha}\` (exportado em ${exportedAt ?? "n/d"})`);
  L.push(`- lock substituído: \`${oldLock}\` (\`${oldLockSha}\`), mantido; os arquivos que ele congelou estão em \`archive/${oldLock.replace(/\.lock\.json$/, "")}/\``);
  L.push(`- lock novo: \`${newLockName}\` (o sha256 vem na saída do comando e no próprio arquivo de lock)`, "");
  L.push("Regra aplicada (protocolo §2.1, §2.2 e §2.3.2): a página respondida `nao` ou `duvida` é excluída (ambígua = excluída) e registrada com `reason: owner-review:<motivo>`;", "o corpus é o resultado de **repetir a caminhada em ordem de hash**, por categoria e fase, com a exclusão do dono como mais um critério: é o que teria saído se a revisão tivesse existido durante a caminhada. As avaliações já registradas que não dependem do estado (http, robots, idioma da página, flags, chars, capture, tipo, regra da SPA) são reaproveitadas; as cotas de domínio, o teto pt/es e o pool do fallback da SPA são recalculados com o conjunto aceito da repetição. Uma candidata antes barrada só por cota, cuja vaga ficou livre, é avaliada na sua posição (e buscada agora, com o mesmo código, UA e regras, porque a cota é checada antes de carregar). Só depois de esgotar o já percorrido a caminhada segue para candidatas nunca visitadas. Nenhuma escolha humana de substituta.", "");
  L.push(`## O que saiu (${exclusions.length + displaced.length})`, "");
  if (exclusions.length + displaced.length === 0) L.push("_nada_", "");
  else {
    L.push("| categoria | URL pedida | URL final | origem | resposta | motivo | nota |", "|---|---|---|---|---|---|---|");
    for (const e of exclusions) L.push(`| ${e.rec.category} | ${cell(e.rec.url)} | ${cell(e.rec.detail?.final_url ?? "")} | dono | ${e.answer} | owner-review:${e.reason}${e.reason_text ? ` (${cell(e.reason_text)})` : ""} | ${cell(e.note)} |`);
    for (const d of displaced) L.push(`| ${d.rec.category} | ${cell(d.rec.url)} | ${cell(d.rec.detail?.final_url ?? "")} | repetição | n/d | ${d.rec.reason}: ${d.why} | |`);
    L.push("");
  }
  L.push(`## O que entrou (${entered.length})`, "");
  if (entered.length === 0) L.push("_nada_", "");
  else {
    L.push("| categoria | URL pedida | URL final | fase | order_hash | por que entrou |", "|---|---|---|---|---|---|");
    for (const { rec: r, why } of entered) L.push(`| ${r.category} | ${cell(r.url)} | ${cell(r.detail?.final_url ?? "")} | ${r.phase} | ${r.order_hash.slice(0, 12)} | ${why} |`);
    L.push("");
  }
  L.push(`Candidatos visitados na reposição e não aceitos: ${visitedExcluded.total}${visitedExcluded.total ? ` (${Object.entries(visitedExcluded.by_reason).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}.`, "");
  L.push("## Contagens por categoria", "", "| categoria | antes | depois | alvo |", "|---|---|---|---|", ...CATEGORIES.map(catRow), `| **total** | ${before.length} | ${after.length} | ${CATEGORIES.reduce((a, c) => a + c.n, 0)} |`, "");
  if (shortfalls.length > 0) {
    L.push("Categorias abaixo do alvo depois da reposição: " + shortfalls.map((s) => `${s.category} ${s.accepted}/${s.target}`).join(", ") + ". O quadro de URLs dessas categorias está esgotado (todos os candidatos já foram avaliados, fora os excluídos pelo dono): elas só perdem páginas, e isso fica registrado aqui. O split-check abaixo usa a regra ajustada do SPA, como antes.", "");
  }
  L.push("## Cotas de domínio (interpretação literal do §2.2)", "");
  L.push("O §2.2 limita as páginas **incluídas** (1 por (domínio, categoria), 2 por domínio). Uma página excluída pelo dono deixa de estar no corpus, então a vaga dela fica livre para qualquer candidata que a repetição avalie depois dela na ordem, inclusive as que antes foram barradas por essa cota. O mesmo vale para o teto de idioma (pt/es). Uma página aceita antes cuja vaga foi tomada por uma candidata reaberta mais cedo na ordem sai com o motivo da cota (listada em \"O que saiu\").", "");
  for (const e of exclusions) {
    const d = groupKeyOf(e.rec);
    L.push(`- ${d} (${e.rec.category}): ${domainTotal(before, d)} página(s) do domínio no corpus antes, ${domainTotal(after, d)} depois.`);
  }
  L.push("", "## SPA e URLs excluídas pelo dono", "", "As URLs excluídas pelo dono não voltam como candidatas em nenhuma categoria nem fase (nem como `spa-fallback`). O pool do fallback é recalculado na repetição com o que as outras categorias aceitaram; se o quadro se esgota, a SPA só perde páginas e isso fica registrado.", "");
  L.push("## Não aplicado", "");
  L.push(`- páginas aceitas mantidas (resposta \`sim\`): ${kept}`);
  L.push(`- páginas aceitas sem resposta no export (mantidas): ${unreviewed.length}`);
  L.push(`- respostas \`nao\`/\`duvida\` sobre exclusões (seções B e C da página): ${ignored.length}. Reincluir uma página excluída não é reposição pela regra; fica para decisão registrada do dono.`, "");
  for (const c of ignored) L.push(`  - [${c.section ?? "?"}] ${c.category} ${cell(c.url)}: ${c.answer} ${cell(c.note)}`);
  L.push("", "## Sal do split (§3)", "", `- antes (${saltBefore.pages} páginas): regra pré-registrada ${saltBefore.pre}; regra ajustada do SPA (>= ${AMENDED_MINIMA.spa.test} test e >= ${AMENDED_MINIMA.spa.dev} dev) ${saltBefore.amended}`);
  L.push(`- depois (${saltAfter.pages} páginas): regra pré-registrada ${saltAfter.pre}; regra ajustada do SPA ${saltAfter.amended}`);
  L.push("", "Só contagens, nunca resultados. O `split-check.txt` traz as contagens por categoria e split. O pipeline é atualizado pelo coordenador.", "");
  return L.join("\n");
}

async function archive(dataDir, lockName) {
  const final = archiveDirOf(dataDir, lockName);
  const tmp = `${final}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  for (const f of ARCHIVED) {
    if (!existsSync(join(dataDir, f))) continue;
    await mkdir(dirname(join(tmp, f)), { recursive: true });
    await copyFile(join(dataDir, f), join(tmp, f));
  }
  await rename(tmp, final);
}

/**
 * @param {string} dataDir
 * @param {string} exportPath
 * @param {{probeVersion?: string, commit?: string|null, now?: Date, check?: boolean, collectorFactory?: (dataDir: string) => any}} [opts]
 *   `check`: validate and print the plan, write nothing.
 */
export async function applyReview(dataDir, exportPath, opts = {}) {
  const { probeVersion, commit, now = new Date(), check = false, collectorFactory = (d) => new Collector(d) } = opts;
  const raw = readFileSync(exportPath);
  const exportSha = sha256Bytes(raw);
  let exp;
  try {
    exp = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    throw new Error(`${exportPath} is not valid JSON: ${e.message}`);
  }

  const locks = listLocks(dataDir);
  if (locks.length === 0) throw new Error(`no corpus lock in ${dataDir}: run \`gp-corpus lock\` first`);
  const done = locks.find((l) => JSON.parse(readFileSync(l.path, "utf8")).review_export_sha256 === exportSha);
  if (done) {
    const problems = verifyLock(dataDir);
    if (problems.length > 0) throw new Error(`this review is already applied (${done.name}) but the corpus no longer matches its lock:\n- ${problems.join("\n- ")}`);
    return { status: "already-applied", lock: done.name };
  }

  const cur = latestLock(dataDir);
  const curSha = sha256File(cur.path);
  const archDir = archiveDirOf(dataDir, cur.name);
  const resume = existsSync(archDir);
  const problems = verifyLock(dataDir, { lockName: cur.name, fromArchive: resume });
  if (problems.length > 0) throw new Error(`the corpus does not match ${cur.name}; nothing was applied:\n- ${problems.join("\n- ")}`);
  const walkedPath = join(dataDir, "walked.jsonl");
  const baseWalked = resume ? join(archDir, "walked.jsonl") : walkedPath;
  if (resume && !readFileSync(walkedPath).subarray(0, readFileSync(baseWalked).length).equals(readFileSync(baseWalked))) {
    throw new Error("walked.jsonl no longer starts with the archived one: it was changed outside apply-review; nothing was applied");
  }
  const records0 = effectiveRecords(readJsonlSync(baseWalked));
  const v = validateReview(exp, { lockSha: curSha, records: records0 });
  if (v.errors.length > 0) throw new Error(`invalid review export (${v.errors.length} problem(s)); nothing was applied:\n- ${v.errors.slice(0, 25).join("\n- ")}${v.errors.length > 25 ? `\n- ... and ${v.errors.length - 25} more` : ""}`);
  const plan = { lock: cur.name, lock_sha256: curSha, export_sha256: exportSha, exclude: v.exclusions.map((e) => ({ category: e.rec.category, url: e.rec.url, answer: e.answer, reason: e.reason })), kept: v.kept, unreviewed: v.unreviewed.length, ignored_checks: v.ignored_checks.length, resume };
  if (check) return { status: "check", plan };

  if (!resume) await archive(dataDir, cur.name);

  // 1. the exclusions (append-only; the ones a crashed run already wrote are not written twice)
  const live = effectiveRecords(readJsonlSync(walkedPath));
  const written = new Set(live.filter((r) => r.review?.export_sha256 === exportSha).map((r) => keyOf(r.category, r.url)));
  let seq = maxSeq(readJsonlSync(walkedPath));
  for (const ex of v.exclusions) {
    if (written.has(keyOf(ex.rec.category, ex.rec.url))) continue;
    appendFileSync(walkedPath, `${JSON.stringify(exclusionRecord(ex, ++seq, { exportSha, lockSha: curSha, now }))}\n`);
  }

  // 2. the replay of the walk, by the same code (Collector) in the same order (see replay.mjs)
  const frame = readJsonlSync(join(dataDir, "frame.jsonl"));
  const collector = collectorFactory(dataDir);
  await collector.init();
  try {
    await replayWalk(collector, frame, effectiveRecords(readJsonlSync(walkedPath)), { exportSha });
  } finally {
    await collector.close();
  }

  // 3. outputs, split check, report, new lock
  await writeOutputs(dataDir);
  await splitCheck(dataDir);
  const records1 = effectiveRecords(readJsonlSync(walkedPath));
  const acc0 = records0.filter((r) => r.outcome === "accepted");
  const acc1 = records1.filter((r) => r.outcome === "accepted");
  const { entered, displaced } = describeChanges(records0, records1, readJsonlSync(walkedPath));
  const seqs0 = new Set(records0.map((r) => r.seq));
  const visited = records1.filter((r) => !seqs0.has(r.seq) && r.outcome === "excluded" && !r.reason.startsWith(OWNER_REVIEW_PREFIX) && !r.replay);
  const by_reason = {};
  for (const r of visited) by_reason[r.reason] = (by_reason[r.reason] ?? 0) + 1;
  const newN = cur.n + 1;
  const newLockName = lockNameOf(newN);
  const exportCopy = `review-export-v0.${newN}.json`;
  await writeFile(join(dataDir, exportCopy), raw);
  const report = buildReport({
    now,
    exportSha,
    exportedAt: exp.exported_at,
    oldLock: cur.name,
    oldLockSha: curSha,
    newLockName,
    before: acc0,
    after: acc1,
    exclusions: v.exclusions,
    entered,
    displaced,
    visitedExcluded: { total: visited.length, by_reason },
    unreviewed: v.unreviewed,
    kept: v.kept,
    ignored: v.ignored_checks,
    saltBefore: saltSummary(records0),
    saltAfter: saltSummary(records1),
    shortfalls: CATEGORIES.map((c) => ({ category: c.name, accepted: acc1.filter((r) => r.category === c.name).length, target: targetOf(c.name) })).filter((s) => s.accepted < s.target),
  });
  await writeFile(join(dataDir, "review-applied.md"), `${report}\n`);
  const { lock, lock_sha256 } = await createLock(dataDir, {
    probeVersion,
    ...(commit === undefined ? {} : { commit }),
    now,
    name: newLockName,
    extraFiles: [exportCopy, "review-applied.md"],
    extra: { supersedes: curSha, supersedes_name: cur.name, review_export_sha256: exportSha, review_export_file: exportCopy },
  });
  return { status: "applied", lock: newLockName, lock_sha256, supersedes: curSha, export_sha256: exportSha, excluded: v.exclusions.length, added: entered.length, reopened: entered.filter((e) => e.reopened).length, displaced: displaced.length, counts: lock.counts, plan };
}
