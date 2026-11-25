// Outputs derived from walked.jsonl: exclusions.jsonl, urls.csv, the SnapshotSet manifest, summary.json and the
// first-20 manual-check aid. Pure functions of the walked records (re-runnable at any time).
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { canonicalJson } from "@gran-prix/contracts";
import { CATEGORIES } from "./config.mjs";
import { writeJsonl, readJsonlSync } from "./jsonl.mjs";
import { effectiveRecords, targetOf } from "./state.mjs";

const csvCell = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** `url,stratum,group_key` rows (accepted pages, category order then walk order) for `gp run`. */
export function urlsCsv(records) {
  const accepted = records.filter((r) => r.outcome === "accepted");
  const order = new Map(CATEGORIES.map((c, i) => [c.name, i]));
  accepted.sort((a, b) => order.get(a.category) - order.get(b.category) || a.seq - b.seq);
  return `url,stratum,group_key\n${accepted.map((r) => [r.url, r.category, r.detail.group_key].map(csvCell).join(",")).join("\n")}${accepted.length ? "\n" : ""}`;
}

/** Counts per category: target, accepted, excluded by reason (first failing reason). */
export function summarize(records) {
  const per = {};
  for (const c of CATEGORIES) per[c.name] = { target: c.n, accepted: 0, walked: 0, excluded: 0, by_reason: {}, non_en: 0, langs: {} };
  for (const r of records) {
    const p = per[r.category];
    if (!p) continue;
    p.walked++;
    if (r.outcome === "accepted") {
      p.accepted++;
      const l = r.detail?.lang ?? "?";
      p.langs[l] = (p.langs[l] ?? 0) + 1;
      if (l !== "en") p.non_en++;
    } else {
      p.excluded++;
      const key = r.reason.replace(/^(http-status-)\d+$/, "$1<code>");
      p.by_reason[key] = (p.by_reason[key] ?? 0) + 1;
    }
  }
  const totals = { target: 0, accepted: 0, walked: 0, excluded: 0 };
  for (const p of Object.values(per)) for (const k of Object.keys(totals)) totals[k] += p[k];
  const domains = {};
  for (const r of records) if (r.outcome === "accepted") (domains[r.category] ??= new Set()).add(r.detail.group_key);
  for (const c of CATEGORIES) per[c.name].distinct_domains = domains[c.name]?.size ?? 0;
  return { categories: per, totals };
}

const FLAG_REASON = /^(flag:|http-status-)/;

/** The aid for "check the first 20 excluded pages by hand" (§2.2). It lists; the verdict is the owner's. */
/** The two views of the first-20 aid: the first exclusions of any reason, and those decided by the page-flag detector. */
export function firstTwenty(records) {
  const excluded = records.filter((r) => r.outcome === "excluded").sort((a, b) => a.seq - b.seq);
  const flagged = excluded.filter((r) => FLAG_REASON.test(r.reason) || (r.also ?? []).some((x) => FLAG_REASON.test(x)));
  return { any: excluded.slice(0, 20), flagged: flagged.slice(0, 20), excluded };
}

export function first20Markdown(records, dataDir) {
  const { excluded, flagged } = firstTwenty(records);
  const section = (title, rows, note) => {
    const lines = [`## ${title}`, "", note, ""];
    rows.slice(0, 20).forEach((r, i) => {
      const shot = r.screenshot ? relative(dataDir, r.screenshot) : null;
      lines.push(`### ${i + 1}. [${r.category}] #${r.seq} ${r.url}`, "");
      lines.push(`- reason: \`${r.reason}\`${r.also?.length ? ` (also: ${r.also.map((x) => `\`${x}\``).join(", ")})` : ""}`);
      const d = r.detail ?? {};
      lines.push(`- http: ${d.http_status ?? d.server_status ?? "n/a"} · flags: ${(d.flags ?? []).join(", ") || "none"} · visible chars: ${d.visible_chars ?? "n/a"} · text elements: ${d.text_elements ?? "n/a"} · lang: ${d.lang ?? "n/a"}`);
      if (d.title) lines.push(`- title: ${JSON.stringify(d.title)}`);
      if (d.message) lines.push(`- message: ${d.message}`);
      lines.push(shot ? `- screenshot: \`${shot}\`` : "- screenshot: none (excluded before the page was loaded, or the load failed)");
      lines.push("- owner verdict (correct exclusion / wrongly excluded / unsure): ______", "");
    });
    if (rows.length === 0) lines.push("_none yet_", "");
    return lines.join("\n");
  };
  return [
    "# First 20 excluded pages: manual check (protocol §2.2)",
    "",
    "Generated from `walked.jsonl`; paths are relative to the corpus data dir. The script does not decide whether an exclusion was right.",
    "The protocol asks the owner to check by hand that the error / captcha / paywall detector excludes the right pages,",
    "because the spike never validated it on real error pages. Two views are given (the protocol sentence admits both readings).",
    "",
    section("A. The first 20 exclusions of any reason, in walk order", excluded, "Walk order is the category table order, then `order_hash`."),
    section("B. The first 20 exclusions decided by the page-flag detector (HTTP status, error, captcha, paywall)", flagged, "These are the ones that test the detector the protocol worries about."),
  ].join("\n");
}

/** Rewrites every derived output from walked.jsonl. */
export async function writeOutputs(dataDir) {
  const records = effectiveRecords(readJsonlSync(join(dataDir, "walked.jsonl")));
  const accepted = records.filter((r) => r.outcome === "accepted");
  await writeJsonl(
    join(dataDir, "exclusions.jsonl"),
    records.filter((r) => r.outcome === "excluded").map((r) => ({ url: r.url, reason: r.reason, category: r.category, also: r.also ?? [], seq: r.seq })),
  );
  await writeFile(join(dataDir, "urls.csv"), urlsCsv(records));
  const manifest = { format: "gran-prix.snapshot-set", format_version: "1.0.0", entries: accepted.map((r) => r.set_entry), failures: [] };
  await mkdir(join(dataDir, "snapshot-set"), { recursive: true });
  await writeFile(join(dataDir, "snapshot-set", "manifest.json"), `${canonicalJson(manifest)}\n`);
  const summary = summarize(records);
  await writeFile(join(dataDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(dataDir, "first20-exclusions.md"), `${first20Markdown(records, dataDir)}\n`);
  return summary;
}

export async function report(dataDir) {
  const s = await writeOutputs(dataDir);
  console.log(JSON.stringify(s, null, 2));
  for (const c of CATEGORIES) if (s.categories[c.name].accepted < targetOf(c.name)) console.log(`note: ${c.name} has ${s.categories[c.name].accepted}/${targetOf(c.name)}`);
}
