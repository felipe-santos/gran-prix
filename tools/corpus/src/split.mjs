// §3 split check: the first salt `gp-dom-v0-s{i}` (i = 0, 1, 2, ...) such that every category has >= 6 pages in the test
// split and >= 17 in dev (= train + val), under the contract `hash-bucket-v1`. Uses counts only, never results.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assignSplit } from "@gran-prix/contracts";
import { CATEGORIES } from "./config.mjs";
import { readJsonlSync } from "./jsonl.mjs";

/** §3: train [0,55), val [55,70), test [70,100). NOTE: the contracts' DEFAULT_SPLIT_RANGES is 70/15/15, not this. */
export const PREREG_RANGES = { train: [0, 55], val: [55, 70], test: [70, 100] };
export const MIN_TEST = 6;
export const MIN_DEV = 17;
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

export const satisfies = (counts) => Object.values(counts).every((c) => c.test >= MIN_TEST && c.dev >= MIN_DEV);

export function firstSalt(pages, maxI = 1000) {
  const tried = [];
  for (let i = 0; i < maxI; i++) {
    const counts = splitCounts(pages, saltOf(i));
    const ok = satisfies(counts);
    tried.push({ i, ok, counts });
    if (ok) return { i, salt: saltOf(i), counts, tried };
  }
  return { i: null, salt: null, counts: null, tried };
}

export async function splitCheck(dataDir) {
  const accepted = readJsonlSync(join(dataDir, "walked.jsonl")).filter((r) => r.outcome === "accepted");
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
  const provisional = CATEGORIES.some((c) => pages.filter((p) => p.category === c.name).length < c.n);
  if (provisional) lines.push(`PROVISIONAL: the corpus is incomplete (${CATEGORIES.map((c) => `${c.name} ${pages.filter((p) => p.category === c.name).length}/${c.n}`).join(", ")})`);
  const text = lines.join("\n");
  console.log(text);
  await writeFile(join(dataDir, "split-check.txt"), `${text}\n`);
  return res;
}
