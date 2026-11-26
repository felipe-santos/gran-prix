// §3 split check: the first salt `gp-dom-v0-s{i}` (i = 0, 1, 2, ...) such that every category has >= 6 pages in the test
// split and >= 17 in dev (= train + val), under the contract `hash-bucket-v1`. Uses counts only, never results.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assignSplit } from "@gran-prix/contracts";
import { CATEGORIES } from "./config.mjs";
import { readJsonlSync } from "./jsonl.mjs";
import { effectiveRecords } from "./state.mjs";

/** §3: train [0,55), val [55,70), test [70,100). NOTE: the contracts' DEFAULT_SPLIT_RANGES is 70/15/15, not this. */
export const PREREG_RANGES = { train: [0, 55], val: [55, 70], test: [70, 100] };
export const MIN_TEST = 6;
export const MIN_DEV = 17;
/**
 * Registered deviation (approved by the owner on 2026-11-25, before any label): the SPA frame is exhausted at 12 of
 * 25 pages, which can never reach 6 test + 17 dev. The five complete categories keep the pre-registered minima; the
 * SPA category needs >= 3 test and >= 6 dev (proportional to its n). Decided on counts only.
 */
export const AMENDED_MINIMA = { spa: { test: 3, dev: 6 } };
const minimaOf = (category, amended) => (amended && AMENDED_MINIMA[category]) || { test: MIN_TEST, dev: MIN_DEV };
export const saltOf = (i) => `gp-dom-v0-s${i}`;

/** `pages` = [{category, group_key}]. Counts pages per category and split. */
export function splitCounts(pages, salt) {
  const out = {};
  for (const c of CATEGORIES) out[c.name] = { train: 0, val: 0, test: 0, dev: 0 };
  for (const p of pages) {
    const { split } = assignSplit(salt, p.group_key, { ranges: PREREG_RANGES });
    const row = out[p.category];
    if (!row) continue;
    row[split]++;
    if (split !== "test") row.dev++;
  }
  return out;
}

export const satisfies = (counts, only, amended = false) =>
  Object.entries(counts).every(([k, c]) => (only && !only.includes(k)) || (c.test >= minimaOf(k, amended).test && c.dev >= minimaOf(k, amended).dev));

/** `only` restricts the rule to some categories (used for the indicative i of the complete categories; never pre-registered). */
export function firstSalt(pages, maxI = 1000, only, amended = false) {
  const tried = [];
  for (let i = 0; i < maxI; i++) {
    const counts = splitCounts(pages, saltOf(i));
    const ok = satisfies(counts, only, amended);
    tried.push({ i, ok, counts });
    if (ok) return { i, salt: saltOf(i), counts, tried };
  }
  return { i: null, salt: null, counts: null, tried };
}

export async function splitCheck(dataDir) {
  const accepted = effectiveRecords(readJsonlSync(join(dataDir, "walked.jsonl"))).filter((r) => r.outcome === "accepted");
  const pages = accepted.map((r) => ({ category: r.category, group_key: r.detail.group_key }));
  const total = pages.length;
  const res = firstSalt(pages);
  const lines = [`pages: ${total} (contract hash-bucket-v1, ranges train [0,55) val [55,70) test [70,100))`];
  for (const t of res.tried.slice(0, 12)) {
    lines.push(`s${t.i}: ${t.ok ? "OK " : "no "} ${CATEGORIES.map((c) => `${c.name} ${t.counts[c.name].dev}/${t.counts[c.name].test}`).join("  ")}   (dev/test)`);
  }
  if (res.i === null) lines.push("no salt up to 1000 satisfies the rule");
  else {
    lines.push(`first i = ${res.i} -> salt ${res.salt}`);
    for (const c of CATEGORIES) {
      const k = res.counts[c.name];
      lines.push(`  ${c.name.padEnd(8)} train ${String(k.train).padStart(2)}  val ${String(k.val).padStart(2)}  test ${String(k.test).padStart(2)}  dev ${String(k.dev).padStart(2)}`);
    }
    const sum = (f) => CATEGORIES.reduce((a, c) => a + res.counts[c.name][f], 0);
    lines.push(`  total    train ${sum("train")}  val ${sum("val")}  test ${sum("test")}  dev ${sum("dev")}`);
  }
  const complete = CATEGORIES.filter((c) => pages.filter((p) => p.category === c.name).length >= c.n).map((c) => c.name);
  if (res.i === null && complete.length > 0 && complete.length < CATEGORIES.length) {
    const ind = firstSalt(pages, 1000, complete);
    lines.push(`INDICATIVE, NOT PRE-REGISTERED: first i for the complete categories only (${complete.join(", ")}): ${ind.i === null ? "none" : `${ind.i} (salt ${ind.salt})`}`);
    if (ind.i !== null) for (const c of CATEGORIES) lines.push(`  ${c.name.padEnd(8)} train ${String(ind.counts[c.name].train).padStart(2)}  val ${String(ind.counts[c.name].val).padStart(2)}  test ${String(ind.counts[c.name].test).padStart(2)}  dev ${String(ind.counts[c.name].dev).padStart(2)}${complete.includes(c.name) ? "" : "   (incomplete, not part of the rule)"}`);
  }
  if (res.i === null) {
    const am = firstSalt(pages, 1000, undefined, true);
    lines.push(`AMENDED RULE (registered deviation, approved by the owner 2026-11-25): spa needs >= ${AMENDED_MINIMA.spa.test} test and >= ${AMENDED_MINIMA.spa.dev} dev, the other categories as pre-registered: ${am.i === null ? "none" : `first i = ${am.i} -> salt ${am.salt}`}`);
    if (am.i !== null) {
      for (const c of CATEGORIES) lines.push(`  ${c.name.padEnd(8)} train ${String(am.counts[c.name].train).padStart(2)}  val ${String(am.counts[c.name].val).padStart(2)}  test ${String(am.counts[c.name].test).padStart(2)}  dev ${String(am.counts[c.name].dev).padStart(2)}`);
      const sum = (f) => CATEGORIES.reduce((a, c) => a + am.counts[c.name][f], 0);
      lines.push(`  total    train ${sum("train")}  val ${sum("val")}  test ${sum("test")}  dev ${sum("dev")}`);
    }
    res.amended = am;
  }
  const provisional = CATEGORIES.some((c) => pages.filter((p) => p.category === c.name).length < c.n);
  if (provisional) lines.push(`PROVISIONAL: the corpus is incomplete (${CATEGORIES.map((c) => `${c.name} ${pages.filter((p) => p.category === c.name).length}/${c.n}`).join(", ")})`);
  const text = lines.join("\n");
  console.log(text);
  await writeFile(join(dataDir, "split-check.txt"), `${text}\n`);
  return res;
}
