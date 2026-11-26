// attempt-diff.md: the pages whose destination changed between attempt 1 (archived in <data>/attempt-1) and the current
// walk (attempt 2), with the cause of each change. A function of the two walked.jsonl files; re-runnable.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CATEGORIES } from "./config.mjs";
import { readJsonlSync } from "./jsonl.mjs";
import { effectiveRecords } from "./state.mjs";

/** url -> {dest, rec}: the accepted record if any, else the first record (a URL can be walked in its own category and again in the SPA fallback). */
function destinations(records) {
  const m = new Map();
  for (const r of records) {
    const cur = m.get(r.url);
    if (r.outcome === "accepted") m.set(r.url, { dest: `accepted:${r.category}`, rec: r });
    else if (!cur) m.set(r.url, { dest: `excluded:${r.reason}`, rec: r });
  }
  return m;
}

const isLanguage = (r) => r && ((r.reason ?? "").startsWith("language") || (r.also ?? []).some((x) => x.startsWith("language")));
const isCaptcha = (r) => r && (r.reason === "flag:captcha" || (r.also ?? []).includes("flag:captcha"));

/** The cause of a destination change, in a fixed priority order. */
export function causeOf(a1, a2, inFrame1) {
  if (!inFrame1) return "quadro (URL not in the attempt-1 frame)";
  if (!a1) return "cascade (attempt 1 never walked it)";
  if (!a2) return "cascade (category filled earlier in attempt 2)";
  const r = a1.rec;
  if (isLanguage(r)) return "idioma (language rule)";
  if (isCaptcha(r)) return "captcha (challenge-page rule)";
  if (r.reason === "adult-content" || (r.also ?? []).includes("adult-content")) return "adulto (adult heuristic)";
  if (r.reason === "out-of-scope-type" || (r.also ?? []).includes("out-of-scope-type")) return "tipo fora do escopo (scope heuristic)";
  if (r.reason === "personal-profile" || r.reason === "pii-evident") return "perfil/PII (heuristic)";
  if (r.reason === "capture" && /not iterable/.test(r.detail?.message ?? "")) return "capture (DOM clobbering in the probe)";
  if (r.reason === "capture" || r.reason === "navigation") return "capture/navigation (transient or site state)";
  if (a2.rec.phase === "spa-fallback" && a2.dest.startsWith("excluded:")) return "cascade (not needed by its category in attempt 2; walked only in the SPA fallback)";
  const net = /^excluded:(http-status|robots|navigation)/;
  if (net.test(a1.dest) || net.test(a2.dest)) return `site state (${a1.dest} -> ${a2.dest}: the site answered differently)`;
  return `cascade or site state (${a1.dest} -> ${a2.dest})`;
}

export async function attemptDiff(dataDir) {
  const w1 = readJsonlSync(join(dataDir, "attempt-1", "walked.jsonl"));
  const w2all = readJsonlSync(join(dataDir, "walked.jsonl"));
  const w2 = effectiveRecords(w2all);
  const frame1 = new Set(readJsonlSync(join(dataDir, "attempt-1", "frame.jsonl")).map((r) => r.url));
  const d1 = destinations(w1);
  const d2 = destinations(w2);
  const urls = [...new Set([...d1.keys(), ...d2.keys()])];
  const changes = [];
  for (const url of urls) {
    const a1 = d1.get(url);
    const a2 = d2.get(url);
    if ((a1?.dest ?? "not-walked") === (a2?.dest ?? "not-walked")) continue;
    changes.push({ url, from: a1?.dest ?? "not-walked", to: a2?.dest ?? "not-walked", cause: causeOf(a1, a2, frame1.has(url)) });
  }
  const acc = (m) => [...m.values()].filter((x) => x.dest.startsWith("accepted:"));
  const byCause = {};
  for (const c of changes) byCause[c.cause.split(" (")[0]] = (byCause[c.cause.split(" (")[0]] ?? 0) + 1;
  const lines = ["# Attempt 1 vs attempt 2: pages that changed destination", ""];
  lines.push("Destination = `accepted:<category>` or `excluded:<first failing reason>` or `not-walked`. Generated from `attempt-1/walked.jsonl` and `walked.jsonl`.", "");
  lines.push("## Accepted pages per category", "", "| category | attempt 1 | attempt 2 |", "|---|---|---|");
  for (const c of CATEGORIES) lines.push(`| ${c.name} | ${acc(d1).filter((x) => x.rec.category === c.name).length} | ${acc(d2).filter((x) => x.rec.category === c.name).length} |`);
  lines.push("", `URLs walked: attempt 1 ${d1.size}, attempt 2 ${d2.size}; destination changed: ${changes.length}.`, "", "## Changes by cause", "", "| cause | pages |", "|---|---|");
  for (const [k, v] of Object.entries(byCause).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} |`);
  const significant = changes.filter((c) => c.from.startsWith("accepted:") || c.to.startsWith("accepted:"));
  lines.push("", `## Pages that entered or left the corpus (${significant.length})`, "", "| url | attempt 1 | attempt 2 | cause |", "|---|---|---|---|");
  for (const c of significant.sort((a, b) => a.cause.localeCompare(b.cause) || a.url.localeCompare(b.url))) lines.push(`| ${c.url.slice(0, 110)} | ${c.from} | ${c.to} | ${c.cause} |`);
  const rest = changes.filter((c) => !significant.includes(c));
  lines.push("", `## Other changes of excluded/not-walked pages (${rest.length})`, "", "Pages excluded in both attempts, or walked in only one, whose recorded reason or presence differs.", "", "| url | attempt 1 | attempt 2 | cause |", "|---|---|---|---|");
  for (const c of rest.sort((a, b) => a.cause.localeCompare(b.cause) || a.url.localeCompare(b.url))) lines.push(`| ${c.url.slice(0, 110)} | ${c.from} | ${c.to} | ${c.cause} |`);
  const revisited = w2.filter((r) => r.supersedes !== undefined);
  lines.push("", `## 2b. Candidates re-evaluated after the collector fixes (${revisited.length})`, "");
  lines.push("Candidates whose exclusion came from a collector defect (Trusted Types in the flatten step, DOM clobbering outside the probe) and that were re-evaluated with the fixed code, same rules, same state. Transient errors (`Execution context was destroyed`, timeouts) are not re-evaluated: their rule is the single retry that already exists.", "");
  if (revisited.length === 0) lines.push("_none_");
  else {
    lines.push("| url | category | before | after |", "|---|---|---|---|");
    for (const r of revisited) {
      const old = w2all.find((x) => x.seq === r.supersedes);
      lines.push(`| ${r.url.slice(0, 110)} | ${r.category} | ${old ? `excluded:${old.reason} (${(old.detail?.message ?? "").slice(0, 80)})` : "?"} | ${r.outcome === "accepted" ? "accepted" : `excluded:${r.reason}`} |`);
    }
  }
  await writeFile(join(dataDir, "attempt-diff.md"), `${lines.join("\n")}\n`);
  console.log(`attempt-diff.md: ${changes.length} changed (${significant.length} entered or left the corpus)`, byCause);
  return { changes, byCause };
}
