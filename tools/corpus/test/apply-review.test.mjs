// apply-review on SYNTHETIC corpora (no page content, no network, no browser): the replacement walk runs the real
// `walkLoop` with a scripted collector that has the same record/quota behaviour as the real one.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyReview, exclusionRecord, saltSummary, validateReview } from "../src/apply-review.mjs";
import { byOrderHash, orderHash } from "../src/hash.mjs";
import { readJsonlSync } from "../src/jsonl.mjs";
import { LOCK_NAME, createLock, latestLock, listLocks, sha256File, verifyLock } from "../src/lock.mjs";
import { writeOutputs } from "../src/report.mjs";
import { REVIEW_FORMAT } from "../src/review-format.mjs";
import { replayWalk } from "../src/replay.mjs";
import { WalkState, effectiveRecords } from "../src/state.mjs";
import { Collector, walkLoop } from "../src/walk.mjs";

const PROBE = "0.2.0";
const dirs = [];
beforeAll(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const hex = (s) => createHash("sha256").update(s).digest("hex");
const row = (category, url, domain, extra = {}) => ({ url, source_dataset: "wcxb", source_type: category, category, order_hash: orderHash(url), domain, ...extra });

const setEntry = (cat, url, domain) => ({ snapshot_id: `sha256:${hex(url)}`, url, final_url: url, stratum: cat, group_key: domain, http_status: 200, flags: [], node_count: 5, snapshot: `snapshots/${hex(url)}.json`, html: `html/${hex(url)}.html.gz` });
const base = (seq, r, phase) => ({ seq, category: r.category, walk_category: r.category, phase, url: r.url, order_hash: r.order_hash, domain: r.domain, source_dataset: "wcxb", source_type: r.source_type, at: "2026-11-25T00:00:00Z" });
const accepted = (seq, r, phase = "primary") => ({ ...base(seq, r, phase), outcome: "accepted", reason: "ok", detail: { http_status: 200, final_url: r.url, group_key: r.domain, title: `t${seq}`, lang: "en", visible_chars: 999, flags: [] }, set_entry: setEntry(r.category, r.url, r.domain) });
const excluded = (seq, r, phase, reason) => ({ ...base(seq, r, phase), outcome: "excluded", reason, detail: { http_status: 200 } });

function writeSnapshot(dir, url) {
  mkdirSync(join(dir, "snapshot-set", "snapshots"), { recursive: true });
  writeFileSync(join(dir, "snapshot-set", "snapshots", `${hex(url)}.json`), JSON.stringify({ probe: { version: PROBE } }));
}

/**
 * A frozen corpus: `article` accepted pages in hash order + `spare` unwalked ones after them; `spa` accepted SPA pages and one
 * rejected, then the spare articles already walked (and rejected) in the SPA fallback, as the real walk leaves it.
 * `sameDomainAs`: the first spare article shares the domain of that accepted article (quota test).
 */
async function fixture({ article = 30, spare = 3, spa = 2, sameDomainAs, barred } = {}) {
  const dir = tmp("gp-corpus-apply-");
  const rows = [];
  for (let i = 0; i < article + spare; i++) rows.push(row("article", `https://a${i}.example/p${i}`, `a${i}.example`));
  rows.sort(byOrderHash);
  const acc = rows.slice(0, article);
  let sp = rows.slice(article);
  if (sameDomainAs !== undefined) {
    const dom = acc[sameDomainAs].domain;
    const lo = acc[article - 1].order_hash;
    const hi = sp.slice(1).reduce((m, r) => (r.order_hash < m ? r.order_hash : m), "g");
    let k = 0;
    let url;
    do url = `https://${dom}/s${k++}`;
    while (!(orderHash(url) > lo && orderHash(url) < hi));
    sp = [row("article", url, dom), ...sp.slice(1)].sort(byOrderHash);
  }
  // `barred` = {after, sameDomainAs}: a candidate between acc[after] and acc[after+1] whose domain is held by acc[sameDomainAs]; the walk
  // recorded it as excluded by the quota BEFORE loading it (so it has no `detail`), exactly as the real walk does
  let bar = null;
  if (barred) {
    const dom = acc[barred.sameDomainAs].domain;
    let k = 0;
    let url;
    do url = `https://${dom}/b${k++}`;
    while (!(orderHash(url) > acc[barred.after].order_hash && orderHash(url) < acc[barred.after + 1].order_hash));
    bar = row("article", url, dom);
  }
  const spaRows = Array.from({ length: spa + 1 }, (_, i) => row("spa", `https://s${i}.example/app`, `s${i}.example`, { spa_flag: true })).sort(byOrderHash);
  let seq = 0;
  const walked = [];
  acc.forEach((r, i) => {
    walked.push(accepted(++seq, r));
    if (bar && i === barred.after) walked.push({ ...excluded(++seq, bar, "primary", "domain-category-quota"), detail: undefined });
  });
  spaRows.forEach((r, i) => walked.push(i < spa ? accepted(++seq, r) : excluded(++seq, r, "primary", "spa-rule:server-text>=200")));
  for (const r of [...(bar ? [bar] : []), ...sp]) walked.push(excluded(++seq, { ...r, category: "spa" }, "spa-fallback", "spa-rule:server-text>=200"));
  writeFileSync(join(dir, "walked.jsonl"), walked.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(dir, "frame.jsonl"), [...acc, ...(bar ? [bar] : []), ...sp, ...spaRows].map((r) => JSON.stringify(r)).join("\n") + "\n");
  for (const r of walked) if (r.outcome === "accepted") writeSnapshot(dir, r.url);
  await writeOutputs(dir);
  await createLock(dir, { probeVersion: PROBE, commit: "test", now: new Date("2026-11-25T12:00:00Z") });
  return { dir, acc, bar, spare: sp, spaRows, files: () => ["walked.jsonl", "urls.csv", "exclusions.jsonl", "summary.json", "split-check.txt", "snapshot-set/manifest.json", "frame.jsonl"].map((f) => [f, existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null]) };
}

/** An export over the lock in force: everything `sim` except the overrides (`{[url]: {answer, reason, ...}}`). */
function makeExport(dir, overrides = {}, patch = {}) {
  const lock = latestLock(dir);
  const recs = effectiveRecords(readJsonlSync(join(dir, "walked.jsonl"))).filter((r) => r.outcome === "accepted");
  const exp = {
    format: REVIEW_FORMAT,
    exported_at: "2026-11-26T00:00:00Z",
    lock_name: lock.name,
    lock_sha256: sha256File(lock.path),
    pages: recs.map((r) => ({ snapshot_id: r.set_entry.snapshot_id, url: r.url, category: r.category, answer: "sim", reason: "", reason_text: "", note: "", ...(overrides[r.url] ?? {}) })),
    exclusion_checks: [],
    ...patch,
  };
  const path = join(tmp("gp-corpus-export-"), "export.json");
  writeFileSync(path, JSON.stringify(exp, null, 2));
  return { exp, path };
}

/** Same record/quota behaviour as the real Collector.visit, with the page outcome scripted. */
class FakeCollector extends Collector {
  /** `wild`: pt pages, pages whose final domain differs, and a default 25% of rejected pages, all derived from the url hash. */
  constructor(dataDir, { reject, boom = false, wild = false } = {}) {
    super(dataDir);
    this.wild = wild;
    this.reject = reject ?? (wild ? (cand) => parseInt(cand.order_hash[2], 16) % 4 === 0 : () => false);
    this.boom = boom;
    this.visited = [];
  }
  async init() {}
  async close() {}
  async prescreen() {
    return {};
  }
  async visit(cand) {
    this.visited.push(`${cand.category}|${cand.url}`);
    if (this.boom) throw new Error("network down");
    const quota = this.state.quotaReason(cand.category, cand.domain);
    if (quota) return this.record(cand, "excluded", quota);
    if (this.reject(cand)) return this.record(cand, "excluded", "flag:error-page", { detail: { http_status: 200 } });
    const h = cand.order_hash;
    const lang = this.wild && parseInt(h[4], 16) % 3 === 0 ? "pt" : "en";
    const group = this.wild && parseInt(h[5], 16) < 2 ? `g${h[6]}.example` : cand.domain;
    const detail = { http_status: 200, final_url: cand.url, group_key: group, title: "new", lang, visible_chars: 999, flags: [] };
    const reasons = [];
    const q = this.state.quotaReason(cand.category, group);
    if (q) reasons.push(`${q}:final-domain`);
    const l = this.state.languageReason(cand.category, lang);
    if (l) reasons.push(l);
    if (reasons.length > 0) return this.record(cand, "excluded", reasons[0], { also: reasons.slice(1), detail });
    writeSnapshot(this.dataDir, cand.url);
    return this.record(cand, "accepted", "ok", { detail, set_entry: setEntry(cand.category, cand.url, group) });
  }
}

const NOW = new Date("2026-11-26T12:00:00Z");
const run = (dir, path, collectorOpts = {}, extra = {}) => {
  const ref = { c: null };
  const p = applyReview(dir, path, { probeVersion: PROBE, commit: "test", now: NOW, collectorFactory: (d) => (ref.c = new FakeCollector(d, collectorOpts)), ...extra });
  return p.then((res) => ({ res, c: ref.c }));
};

describe("validateReview", () => {
  const rec = (n) => accepted(n, row("article", `https://v${n}.example/x`, `v${n}.example`));
  const records = [rec(1), rec(2), rec(3)];
  const page = (r, extra = {}) => ({ snapshot_id: r.set_entry.snapshot_id, url: r.url, category: r.category, answer: "sim", reason: "", ...extra });
  const exp = (pages, extra = {}) => ({ format: REVIEW_FORMAT, lock_sha256: "sha256:L", pages, ...extra });
  const v = (e, extra = {}) => validateReview(e, { lockSha: "sha256:L", records, ...extra });

  it("accepts a valid export: nao and duvida exclude (in corpus order), sim keeps", () => {
    const r = v(exp([page(records[2], { answer: "duvida", reason: "login" }), page(records[1]), page(records[0], { answer: "nao", reason: "erro-soft404", note: "404" })]));
    expect(r.errors).toEqual([]);
    expect(r.exclusions.map((e) => [e.rec.seq, e.answer, e.reason])).toEqual([[1, "nao", "erro-soft404"], [3, "duvida", "login"]]);
    expect(r.unreviewed).toEqual([]);
    expect(r.kept).toBe(1);
  });
  it("refuses an export with an accepted page without an answer (empty or missing), listing them; --allow-partial keeps them and says so", () => {
    const e = exp([page(records[0], { answer: "nao", reason: "login" }), page(records[1], { answer: "" })]); // records[2] is missing altogether
    const r = v(e);
    expect(r.errors.join("\n")).toMatch(/2 accepted page\(s\) without an answer/);
    expect(r.errors.join("\n")).toContain(records[1].url);
    expect(r.errors.join("\n")).toContain(records[2].url);
    const p = v(e, { allowPartial: true });
    expect(p.errors).toEqual([]);
    expect(p.unreviewed.map((x) => x.seq)).toEqual([2, 3]);
    expect(p.exclusions).toHaveLength(1);
  });
  it("an exclusion without a reason is recorded as sem-motivo", () => {
    expect(v(exp([page(records[0], { answer: "nao" })])).exclusions[0].reason).toBe("sem-motivo");
  });
  it("refuses another lock, another format, an unknown page, a duplicate, a wrong snapshot id, a bad answer and an unknown reason", () => {
    expect(v(exp([], { lock_sha256: "sha256:OTHER" })).errors.join(" ")).toMatch(/another corpus/);
    expect(v(exp([], { format: "x/1" })).errors.join(" ")).toMatch(/format/);
    expect(v(exp([{ ...page(records[0]), url: "https://nope.example/" }])).errors.join(" ")).toMatch(/not an accepted page/);
    expect(v(exp([page(records[0]), page(records[0])])).errors.join(" ")).toMatch(/duplicate/);
    expect(v(exp([{ ...page(records[0]), snapshot_id: "sha256:zz" }])).errors.join(" ")).toMatch(/snapshot_id/);
    expect(v(exp([page(records[0], { answer: "talvez" })])).errors.join(" ")).toMatch(/answer/);
    expect(v(exp([page(records[0], { answer: "nao", reason: "porque sim" })])).errors.join(" ")).toMatch(/unknown reason/);
    expect(v([]).errors.join(" ")).toMatch(/not a JSON object/);
  });
  it("answers on exclusions (sections B and C) are listed as not applied", () => {
    const r = v(exp([], { exclusion_checks: [{ answer: "nao", url: "u" }, { answer: "sim", url: "w" }] }));
    expect(r.ignored_checks).toHaveLength(1);
  });
});

describe("exclusion record", () => {
  it("supersedes the accepted one, keeps the evidence and carries the review", () => {
    const o = accepted(7, row("article", "https://q.example/a", "q.example"));
    const r = exclusionRecord({ rec: o, answer: "nao", reason: "login", reason_text: "", note: "n" }, 99, { exportSha: "sha256:E", lockSha: "sha256:L", now: NOW });
    expect(r).toMatchObject({ seq: 99, supersedes: 7, outcome: "excluded", reason: "owner-review:login", category: "article", url: o.url, order_hash: o.order_hash, phase: "primary" });
    expect(r.detail).toEqual(o.detail);
    expect(r.review).toMatchObject({ answer: "nao", export_sha256: "sha256:E", lock_sha256: "sha256:L" });
    expect(effectiveRecords([o, r]).map((x) => x.seq)).toEqual([99]);
    expect(WalkState.replay(effectiveRecords([o, r])).blocked.has(o.url)).toBe(true);
  });
});

describe("apply-review", () => {
  it("an exclusion pulls the NEXT candidate of its category in hash order, and nothing else", async () => {
    const f = await fixture();
    const out = f.acc[7];
    const before = f.files();
    const { path } = makeExport(f.dir, { [out.url]: { answer: "nao", reason: "erro-soft404", note: "soft 404" } });
    const { res, c } = await run(f.dir, path);

    expect(res.status).toBe("applied");
    expect(res).toMatchObject({ excluded: 1, added: 1, lock: "corpus-v0.1.lock.json" });
    expect(c.visited).toEqual([`article|${f.spare[0].url}`]); // the first spare in hash order; the other two are not touched
    const eff = effectiveRecords(readJsonlSync(join(f.dir, "walked.jsonl")));
    const art = eff.filter((r) => r.category === "article" && r.outcome === "accepted");
    expect(art).toHaveLength(30);
    expect(art.map((r) => r.url)).toContain(f.spare[0].url);
    expect(art.map((r) => r.url)).not.toContain(out.url);
    expect(eff.find((r) => r.url === out.url && r.category === "article")).toMatchObject({ outcome: "excluded", reason: "owner-review:erro-soft404", supersedes: 8 });
    // SPA is below its target and its frame is exhausted: it only loses nothing here (nobody was excluded in it) and gains nothing
    expect(eff.filter((r) => r.category === "spa" && r.outcome === "accepted")).toHaveLength(2);

    // the trail is kept: walked.jsonl only grew, and its old prefix is byte-identical
    const walkedBefore = before.find(([n]) => n === "walked.jsonl")[1];
    expect(readFileSync(join(f.dir, "walked.jsonl"), "utf8").startsWith(walkedBefore)).toBe(true);
    // outputs follow the corpus
    const csv = readFileSync(join(f.dir, "urls.csv"), "utf8");
    expect(csv).toContain(f.spare[0].url);
    expect(csv).not.toContain(out.url);
    expect(readFileSync(join(f.dir, "exclusions.jsonl"), "utf8")).toContain("owner-review:erro-soft404");
    expect(readFileSync(join(f.dir, "split-check.txt"), "utf8")).toMatch(/AMENDED RULE|first i =/);
    const md = readFileSync(join(f.dir, "review-applied.md"), "utf8");
    expect(md).toContain(out.url);
    expect(md).toContain(f.spare[0].url);
    expect(md).toContain("erro-soft404");
    expect(md).toMatch(/Sal do split/);
  });

  it("writes a new lock that supersedes the old one, keeps the old lock verifiable, and both pass", async () => {
    const f = await fixture();
    const oldSha = sha256File(join(f.dir, LOCK_NAME));
    const oldLockBytes = readFileSync(join(f.dir, LOCK_NAME), "utf8");
    const { path } = makeExport(f.dir, { [f.acc[0].url]: { answer: "duvida", reason: "categoria-errada" } });
    const { res } = await run(f.dir, path);
    expect(listLocks(f.dir).map((l) => l.name)).toEqual([LOCK_NAME, "corpus-v0.1.lock.json"]);
    expect(readFileSync(join(f.dir, LOCK_NAME), "utf8")).toBe(oldLockBytes); // the v0 lock is not touched
    const lock = JSON.parse(readFileSync(join(f.dir, "corpus-v0.1.lock.json"), "utf8"));
    expect(lock.supersedes).toBe(oldSha);
    expect(lock.review_export_sha256).toBe(`sha256:${hex(readFileSync(path, "utf8"))}`);
    expect(res.lock_sha256).toBe(sha256File(join(f.dir, "corpus-v0.1.lock.json")));
    expect(Object.keys(lock.files)).toEqual(expect.arrayContaining(["walked.jsonl", "review-applied.md", "review-export-v0.1.json"]));
    expect(verifyLock(f.dir)).toEqual([]); // latest = v0.1
    expect(verifyLock(f.dir, { lockName: LOCK_NAME })).toEqual([]); // v0, from archive/
    expect(existsSync(join(f.dir, "archive", "corpus-v0", "walked.jsonl"))).toBe(true);
    // and v0 would NOT pass against the live files: the archive is what keeps it verifiable
    expect(verifyLock(f.dir, { lockName: LOCK_NAME, fromArchive: false }).join(" ")).toMatch(/walked\.jsonl: sha256 changed/);
  });

  it("an exclusion frees the domain quota for the replacement; without it the same candidate is refused by the quota", async () => {
    const f = await fixture({ sameDomainAs: 5 });
    expect(f.spare[0].domain).toBe(f.acc[5].domain);
    const { path } = makeExport(f.dir, { [f.acc[5].url]: { answer: "nao", reason: "login" } });
    const { c } = await run(f.dir, path);
    const rec = effectiveRecords(readJsonlSync(join(f.dir, "walked.jsonl"))).find((r) => r.url === f.spare[0].url && r.category === "article");
    expect(c.visited[0]).toBe(`article|${f.spare[0].url}`);
    expect(rec).toMatchObject({ outcome: "accepted" }); // the quota of the domain was freed

    const g = await fixture({ sameDomainAs: 5 });
    const { path: p2 } = makeExport(g.dir, { [g.acc[9].url]: { answer: "nao", reason: "login" } }); // another page: the domain stays occupied
    const r2 = await run(g.dir, p2);
    const recs = effectiveRecords(readJsonlSync(join(g.dir, "walked.jsonl")));
    expect(recs.find((r) => r.url === g.spare[0].url && r.category === "article")).toMatchObject({ outcome: "excluded", reason: "domain-category-quota" });
    expect(recs.find((r) => r.url === g.spare[1].url && r.category === "article")).toMatchObject({ outcome: "accepted" }); // the one after it
    expect(r2.res.added).toBe(1);
  });

  it("SPA with an exhausted frame only loses pages, and the owner-excluded URL is never a candidate again", async () => {
    const f = await fixture({ spare: 0, spa: 3 });
    const spaOut = f.spaRows.find((r) => effectiveRecords(readJsonlSync(join(f.dir, "walked.jsonl"))).some((x) => x.url === r.url && x.outcome === "accepted"));
    const { path } = makeExport(f.dir, { [spaOut.url]: { answer: "nao", reason: "desafio" }, [f.acc[1].url]: { answer: "nao", reason: "home-listagem" } });
    const { res, c } = await run(f.dir, path);
    const eff = effectiveRecords(readJsonlSync(join(f.dir, "walked.jsonl")));
    expect(eff.filter((r) => r.category === "spa" && r.outcome === "accepted")).toHaveLength(2); // 3 -> 2: no candidate left
    expect(res.counts.spa.accepted).toBe(2);
    // article: no spare either, so it also only loses; the excluded article URL is not offered to the SPA fallback
    expect(res.counts.article.accepted).toBe(29);
    expect(c.visited).toEqual([]);
    const md = readFileSync(join(f.dir, "review-applied.md"), "utf8");
    expect(md).toMatch(/Categorias abaixo do alvo/);
    expect(md).toMatch(/spa 2\/25/);
  });

  it("a plain walk never offers a URL the owner excluded, in any category or phase", async () => {
    const f = await fixture({ spare: 0 });
    const url = f.acc[2].url;
    const rec = effectiveRecords(readJsonlSync(join(f.dir, "walked.jsonl"))).find((r) => r.url === url);
    const ex = exclusionRecord({ rec, answer: "nao", reason: "login", reason_text: "", note: "" }, 9999, { exportSha: "sha256:E", lockSha: "sha256:L", now: NOW });
    writeFileSync(join(f.dir, "walked.jsonl"), readFileSync(join(f.dir, "walked.jsonl"), "utf8") + JSON.stringify(ex) + "\n");
    const c = new FakeCollector(f.dir);
    const frame = readJsonlSync(join(f.dir, "frame.jsonl"));
    expect(c.state.blocked.has(url)).toBe(true);
    const early = row("article", "https://early.example/e", "early.example");
    early.order_hash = "0".repeat(64);
    await walkLoop(c, [...frame, early], ["article", "spa"], { pauseMs: 0 });
    expect(c.visited).toEqual(["article|https://early.example/e"]);
  });

  it("an export with unanswered pages is refused (nothing written); --allow-partial applies it and records it in the lock and in review-applied.md", async () => {
    const f = await fixture();
    const before = f.files();
    const { path } = makeExport(f.dir, { [f.acc[3].url]: { answer: "" }, [f.acc[4].url]: { answer: "nao", reason: "login" }, [f.acc[9].url]: { answer: "" } });
    await expect(run(f.dir, path)).rejects.toThrow(new RegExp(`2 accepted page\\(s\\) without an answer[\\s\\S]*${f.acc[3].url.replace(/[.]/g, "\\.")}`));
    expect(f.files()).toEqual(before);
    expect(listLocks(f.dir)).toHaveLength(1);
    expect(existsSync(join(f.dir, "archive"))).toBe(false);

    const { res } = await run(f.dir, path, {}, { allowPartial: true });
    expect(res.status).toBe("applied");
    expect(res.plan).toMatchObject({ unanswered: 2, allow_partial: true });
    const lock = JSON.parse(readFileSync(join(f.dir, "corpus-v0.1.lock.json"), "utf8"));
    expect(lock).toMatchObject({ review_allow_partial: true, review_unanswered: 2 });
    const md = readFileSync(join(f.dir, "review-applied.md"), "utf8");
    expect(md).toMatch(/ATENÇÃO: aplicada com `--allow-partial`/);
    expect(md).toContain(f.acc[3].url);
    expect(md).toContain(f.acc[9].url);
  });

  it("a complete review records allow_partial = false in the lock", async () => {
    const f = await fixture();
    const { path } = makeExport(f.dir, { [f.acc[3].url]: { answer: "nao", reason: "login" } });
    await run(f.dir, path);
    expect(JSON.parse(readFileSync(join(f.dir, "corpus-v0.1.lock.json"), "utf8"))).toMatchObject({ review_allow_partial: false, review_unanswered: 0 });
  });

  it("a wrong lock is refused and nothing is written", async () => {
    const f = await fixture();
    const before = f.files();
    const { path } = makeExport(f.dir, { [f.acc[0].url]: { answer: "nao", reason: "login" } }, { lock_sha256: "sha256:" + "0".repeat(64) });
    await expect(run(f.dir, path)).rejects.toThrow(/another corpus/);
    expect(f.files()).toEqual(before);
    expect(listLocks(f.dir)).toHaveLength(1);
    expect(existsSync(join(f.dir, "archive"))).toBe(false);
    expect(existsSync(join(f.dir, "review-applied.md"))).toBe(false);
  });

  it("a corpus that no longer matches its lock is refused", async () => {
    const f = await fixture();
    const { path } = makeExport(f.dir, { [f.acc[0].url]: { answer: "nao", reason: "login" } });
    writeFileSync(join(f.dir, "urls.csv"), "tampered\n", { flag: "a" });
    await expect(run(f.dir, path)).rejects.toThrow(/does not match corpus-v0\.lock\.json/);
  });

  it("a page outside the corpus or a duplicate in the export is refused and nothing is written", async () => {
    const f = await fixture();
    const before = f.files();
    const { exp } = makeExport(f.dir);
    const bad = join(tmp("gp-corpus-export-"), "bad.json");
    writeFileSync(bad, JSON.stringify({ ...exp, pages: [...exp.pages, exp.pages[0], { ...exp.pages[1], url: "https://not-in-corpus.example/" }] }));
    await expect(run(f.dir, bad)).rejects.toThrow(/duplicate page[\s\S]*not an accepted page|not an accepted page[\s\S]*duplicate page/);
    expect(f.files()).toEqual(before);
  });

  it("--check validates and prints the plan without writing", async () => {
    const f = await fixture();
    const before = f.files();
    const { path } = makeExport(f.dir, { [f.acc[3].url]: { answer: "nao", reason: "login" } });
    const { res, c } = await run(f.dir, path, {}, { check: true });
    expect(res.status).toBe("check");
    expect(res.plan.exclude).toEqual([{ category: "article", url: f.acc[3].url, answer: "nao", reason: "login" }]);
    expect(c).toBeNull();
    expect(f.files()).toEqual(before);
    expect(existsSync(join(f.dir, "archive"))).toBe(false);
  });

  it("applying the same review twice changes nothing the second time", async () => {
    const f = await fixture();
    const { path } = makeExport(f.dir, { [f.acc[4].url]: { answer: "nao", reason: "login" }, [f.acc[6].url]: { answer: "duvida", reason: "outro", reason_text: "?" } });
    const first = await run(f.dir, path);
    expect(first.res.status).toBe("applied");
    const snap = () => [...f.files(), ...["corpus-v0.1.lock.json", "review-applied.md", "review-export-v0.1.json", LOCK_NAME].map((n) => [n, readFileSync(join(f.dir, n), "utf8")])];
    const after1 = snap();
    const second = await run(f.dir, path);
    expect(second.res).toEqual({ status: "already-applied", lock: "corpus-v0.1.lock.json" });
    expect(second.c).toBeNull(); // no walk, no browser
    expect(snap()).toEqual(after1);
    expect(listLocks(f.dir)).toHaveLength(2);
  });

  it("a review that confirms everything still records a lock, and a second review needs an export made over the new lock", async () => {
    const f = await fixture();
    const { path } = makeExport(f.dir);
    const { res } = await run(f.dir, path);
    expect(res).toMatchObject({ status: "applied", excluded: 0, added: 0 });
    const stale = makeExport(f.dir, {}, { lock_sha256: sha256File(join(f.dir, LOCK_NAME)) });
    await expect(run(f.dir, stale.path)).rejects.toThrow(/another corpus/);
    const next = makeExport(f.dir, { [f.acc[2].url]: { answer: "nao", reason: "login" } }); // made over v0.1
    const r2 = await run(f.dir, next.path);
    expect(r2.res).toMatchObject({ status: "applied", lock: "corpus-v0.2.lock.json", excluded: 1, added: 1 });
    expect([verifyLock(f.dir), verifyLock(f.dir, { lockName: LOCK_NAME }), verifyLock(f.dir, { lockName: "corpus-v0.1.lock.json" })]).toEqual([[], [], []]);
  });

  it("a run that dies after the exclusions were written is finished by running the same command again, with the same result as a clean run", async () => {
    const clean = await fixture();
    const spareOf = (f) => f.spare[0].url;
    const mk = (f) => makeExport(f.dir, { [f.acc[7].url]: { answer: "nao", reason: "login" } }).path;
    await run(clean.dir, mk(clean));

    const f = await fixture();
    const path = mk(f);
    await expect(run(f.dir, path, { boom: true })).rejects.toThrow(/network down/);
    expect(listLocks(f.dir)).toHaveLength(1); // no new lock yet
    const midway = readJsonlSync(join(f.dir, "walked.jsonl")).filter((r) => r.review);
    expect(midway).toHaveLength(1);
    const { res } = await run(f.dir, path);
    expect(res.status).toBe("applied");
    const recsOf = (d) => effectiveRecords(readJsonlSync(join(d, "walked.jsonl"))).map((r) => [r.category, r.outcome, r.reason, r.url === spareOf(f) || r.url === spareOf(clean) ? "SPARE0" : r.url.replace(/^https:\/\//, "")]);
    expect(readJsonlSync(join(f.dir, "walked.jsonl")).filter((r) => r.review)).toHaveLength(1); // not written twice
    expect(recsOf(f.dir).length).toBe(recsOf(clean.dir).length);
    expect(readFileSync(join(f.dir, "urls.csv"), "utf8").split("\n").length).toBe(readFileSync(join(clean.dir, "urls.csv"), "utf8").split("\n").length);
    expect(verifyLock(f.dir)).toEqual([]);
    expect(verifyLock(f.dir, { lockName: LOCK_NAME })).toEqual([]);
  });
});

describe("replay (the corpus is what the walk would have produced with the review in place)", () => {
  it("a candidate barred only by a quota the excluded page held is reopened at its position, and the one after the old cursor is not needed", async () => {
    const f = await fixture({ barred: { after: 10, sameDomainAs: 5 } });
    expect(f.bar.domain).toBe(f.acc[5].domain);
    const { path } = makeExport(f.dir, { [f.acc[5].url]: { answer: "nao", reason: "categoria-errada" } });
    const { res, c } = await run(f.dir, path);
    expect(c.visited).toEqual([`article|${f.bar.url}`]); // fetched now: the quota is checked before loading, so it never was
    expect(res).toMatchObject({ excluded: 1, added: 1, reopened: 1, displaced: 0 });
    const eff = effectiveRecords(readJsonlSync(join(f.dir, "walked.jsonl")));
    const b = eff.find((r) => r.category === "article" && r.url === f.bar.url);
    expect(b).toMatchObject({ outcome: "accepted", supersedes: 12 });
    expect(eff.filter((r) => r.category === "article" && r.outcome === "accepted")).toHaveLength(30);
    expect(eff.find((r) => r.url === f.spare[0].url && r.category === "article")).toBeUndefined(); // nothing past the old cursor was visited
    const md = readFileSync(join(f.dir, "review-applied.md"), "utf8");
    expect(md).toMatch(/reaberta: estava excluída por `domain-category-quota`/);
    expect(md).toContain(f.bar.url);
  });

  it("while the domain stays occupied the barred candidate stays barred and the walk goes on past the old cursor", async () => {
    const f = await fixture({ barred: { after: 10, sameDomainAs: 5 } });
    const { path } = makeExport(f.dir, { [f.acc[20].url]: { answer: "duvida", reason: "outro", reason_text: "?" } });
    const { c } = await run(f.dir, path);
    expect(c.visited).toEqual([`article|${f.spare[0].url}`]);
    const eff = effectiveRecords(readJsonlSync(join(f.dir, "walked.jsonl")));
    expect(eff.find((r) => r.category === "article" && r.url === f.bar.url)).toMatchObject({ outcome: "excluded", reason: "domain-category-quota" });
  });

  it("is a fixed point: replaying the result again visits nothing and writes nothing", async () => {
    const f = await fixture({ barred: { after: 10, sameDomainAs: 5 } });
    const { path } = makeExport(f.dir, { [f.acc[5].url]: { answer: "nao", reason: "login" }, [f.acc[8].url]: { answer: "nao", reason: "login" } });
    await run(f.dir, path);
    const before = readFileSync(join(f.dir, "walked.jsonl"), "utf8");
    const c = new FakeCollector(f.dir);
    await replayWalk(c, readJsonlSync(join(f.dir, "frame.jsonl")), effectiveRecords(readJsonlSync(join(f.dir, "walked.jsonl"))));
    expect(c.visited).toEqual([]);
    expect(readFileSync(join(f.dir, "walked.jsonl"), "utf8")).toBe(before);
  });

  it("an accepted page past the target is superseded as replay:target-reached, without fetching", async () => {
    const f = await fixture({ article: 31, spare: 0 });
    const c = new FakeCollector(f.dir);
    const { events } = await replayWalk(c, readJsonlSync(join(f.dir, "frame.jsonl")), effectiveRecords(readJsonlSync(join(f.dir, "walked.jsonl"))));
    // the 31st page is not an article any more, so it is a candidate of the SPA fallback pool, as in the sequential walk
    expect(c.visited).toEqual([`spa|${f.acc[30].url}`]);
    expect(events.filter((e) => e.type === "displaced").map((e) => [e.reason, e.url])).toEqual([["replay:target-reached", f.acc[30].url]]);
    const rec = effectiveRecords(readJsonlSync(join(f.dir, "walked.jsonl"))).find((r) => r.url === f.acc[30].url && r.category === "article");
    expect(rec).toMatchObject({ outcome: "excluded", reason: "replay:target-reached", replay: { kind: "displaced" } });
  });

  // The coordinator's invariant: "review applied afterwards" == "the same exclusions applied as a rule from the start".
  // Synthetic frames with many domain collisions, pt pages, redirects to other domains and rejected pages; the walk
  // below is the plain sequential walk (walkLoop) with the owner's URLs blocked from the beginning.
  const synth = (seed) => {
    let x = seed;
    const rnd = () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const rows = [];
    for (const cat of ["article", "product", "docs", "forum", "landing"]) for (let i = 0; i < 70; i++) rows.push(row(cat, `https://d${Math.floor(rnd() * 55)}.example/${cat}/${i}`, null));
    for (let i = 0; i < 8; i++) rows.push(row("spa", `https://sp${i}.example/app`, null, { spa_flag: true }));
    return rows.map((r) => ({ ...r, domain: new URL(r.url).hostname }));
  };
  const acceptedSets = (dir) => {
    const out = {};
    for (const r of effectiveRecords(readJsonlSync(join(dir, "walked.jsonl")))) if (r.outcome === "accepted") (out[r.category] ??= []).push(r.url);
    for (const k of Object.keys(out)) out[k].sort();
    return out;
  };
  const CATS = ["article", "product", "docs", "forum", "landing", "spa"];

  async function equalityCase(seed) {
    const frame = synth(seed);
    const mk = () => {
      const d = tmp("gp-corpus-eq-");
      writeFileSync(join(d, "frame.jsonl"), frame.map((r) => JSON.stringify(r)).join("\n") + "\n");
      return d;
    };
    // frozen corpus: the plain walk
    const A = mk();
    const walkA = new FakeCollector(A, { wild: true });
    await walkLoop(walkA, frame, CATS, { pauseMs: 0 });
    await writeOutputs(A);
    await createLock(A, { probeVersion: PROBE, commit: "test", now: new Date("2026-11-25T12:00:00Z") });
    const recs0 = effectiveRecords(readJsonlSync(join(A, "walked.jsonl")));
    const acc0 = recs0.filter((r) => r.outcome === "accepted");
    expect(acc0.length).toBeGreaterThan(60);

    // the owner excludes pages whose domain also appears in a candidate that was barred by quota (so something can reopen), plus a pt page and a spa page
    const barredDomains = new Set(recs0.filter((r) => r.outcome === "excluded" && /quota/.test(r.reason)).map((r) => r.domain));
    const picks = acc0.filter((r) => barredDomains.has(r.domain) || barredDomains.has(r.detail.group_key)).filter((_, i) => i % 3 === 0).slice(0, 6);
    picks.push(acc0.find((r) => r.detail.lang === "pt" && !picks.includes(r)), acc0.find((r) => r.category === "spa" && !picks.includes(r)));
    const E = picks.filter(Boolean);
    expect(E.length).toBeGreaterThanOrEqual(3);

    const { path } = makeExport(A, Object.fromEntries(E.map((r) => [r.url, { answer: "nao", reason: "categoria-errada" }])));
    const { res } = await run(A, path, { wild: true });
    expect(res.status).toBe("applied");

    // the same exclusions as a rule from the start
    const B = mk();
    const walkB = new FakeCollector(B, { wild: true });
    for (const r of E) walkB.state.blocked.add(r.url);
    await walkLoop(walkB, frame, CATS, { pauseMs: 0 });

    expect(acceptedSets(A)).toEqual(acceptedSets(B));
    // the result obeys the quotas, and the new lock verifies
    const st = WalkState.replay(effectiveRecords(readJsonlSync(join(A, "walked.jsonl"))));
    for (const n of st.domainCategory.values()) expect(n).toBeLessThanOrEqual(1);
    for (const n of st.domainTotal.values()) expect(n).toBeLessThanOrEqual(2);
    expect(verifyLock(A)).toEqual([]);
    expect(verifyLock(A, { lockName: LOCK_NAME })).toEqual([]);
    // and applying the same review again changes nothing
    const again = await run(A, path, { wild: true });
    expect(again.res.status).toBe("already-applied");
    return { reopened: res.reopened, displaced: res.displaced, excluded: E.length };
  }

  it("applying the exclusions afterwards equals a walk with them blocked from the start (4 synthetic corpora)", async () => {
    let reopened = 0;
    for (const seed of [1, 2, 3, 4]) reopened += (await equalityCase(seed)).reopened;
    expect(reopened).toBeGreaterThan(0); // the reopening path was exercised, not just the trivial case
  }, 120_000);
});

describe("saltSummary", () => {
  it("reports both readings of the rule, from counts only", () => {
    const recs = [];
    for (const [cat, n] of [["article", 40], ["product", 40], ["docs", 40], ["forum", 40], ["landing", 40], ["spa", 40]]) for (let i = 0; i < n; i++) recs.push({ outcome: "accepted", category: cat, detail: { group_key: `${cat}${i}.example` } });
    const s = saltSummary(recs);
    expect(s.pages).toBe(240);
    expect(s.pre).toMatch(/^i = \d+ \(gp-dom-v0-s\d+\)$/);
    expect(s.amended_i).toBeLessThanOrEqual(s.pre_i);
  });
});
