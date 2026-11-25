import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { LOCKED_FILES, createLock, verifyLock } from "../src/lock.mjs";
import { buildReviewHtml, isRuleDecided } from "../src/review-page.mjs";

const dirs = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const acc = (seq, category, domain) => ({
  seq, category, walk_category: category, url: `https://${domain}/p${seq}`, domain, source_dataset: seq % 2 ? "wcxb" : "webmainbench", source_type: "article", phase: "primary",
  outcome: "accepted", reason: "ok", screenshot: `/data/screens/${category}-${seq}.jpg`,
  detail: { lang: "en", group_key: domain, title: `T <${seq}>`, visible_chars: 999 },
  set_entry: { snapshot: `snapshots/s${seq}.json` },
});
const exc = (seq, category, reason, extra = {}) => ({ seq, category, walk_category: category, url: `https://x${seq}.example/a?b=1&c=2`, outcome: "excluded", reason, also: [], detail: { http_status: 200 }, ...extra });

function fixtureDir() {
  const d = mkdtempSync(join(tmpdir(), "gp-corpus-lock-"));
  dirs.push(d);
  mkdirSync(join(d, "snapshot-set", "snapshots"), { recursive: true });
  const rows = [acc(1, "article", "a.com"), acc(2, "docs", "b.org"), exc(3, "article", "http-status-403")];
  writeFileSync(join(d, "walked.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  for (const s of [1, 2]) writeFileSync(join(d, "snapshot-set", "snapshots", `s${s}.json`), JSON.stringify({ probe: { version: "0.2.0" } }));
  writeFileSync(join(d, "frame.jsonl"), '{"url":"https://a.com/p1"}\n');
  writeFileSync(join(d, "exclusions.jsonl"), '{"url":"https://x3.example/a","reason":"http-status-403"}\n');
  writeFileSync(join(d, "urls.csv"), "url,stratum,group_key\nhttps://a.com/p1,article,a.com\n");
  writeFileSync(join(d, "snapshot-set", "manifest.json"), '{"entries":[]}\n');
  return d;
}

describe("corpus lock", () => {
  it("records every frozen file, the counts, the domains, the probe version and the seed; verify passes right after", async () => {
    const d = fixtureDir();
    const { lock, lock_sha256 } = await createLock(d, { probeVersion: "0.2.0", commit: "abc123", now: new Date("2026-11-25T12:00:00Z") });
    expect(Object.keys(lock.files).sort()).toEqual([...LOCKED_FILES].sort());
    expect(lock).toMatchObject({ code_commit: "abc123", probe_version: "0.2.0", seed: 20261125, created_at: "2026-11-25T12:00:00.000Z", total_accepted: 2, snapshot_probe_versions: ["0.2.0"] });
    expect(lock.counts.article).toEqual({ target: 30, accepted: 1 });
    expect(lock.domains.docs).toEqual(["b.org"]);
    expect(lock_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyLock(d)).toEqual([]);
  });
  it("fails when any frozen file changes, and when a snapshot goes missing", async () => {
    for (const f of LOCKED_FILES) {
      const d = fixtureDir();
      await createLock(d, { probeVersion: "0.2.0", commit: "x" });
      writeFileSync(join(d, f), "tampered\n", { flag: "a" });
      const problems = verifyLock(d);
      expect(problems.length, f).toBeGreaterThan(0);
      expect(problems.join(" "), f).toContain(f);
    }
    const d = fixtureDir();
    await createLock(d, { probeVersion: "0.2.0", commit: "x" });
    rmSync(join(d, "snapshot-set", "snapshots", "s1.json"));
    expect(verifyLock(d).join(" ")).toMatch(/missing/);
  });
  it("the CLI exits 1 on a mismatch and 0 otherwise", async () => {
    const d = fixtureDir();
    await createLock(d, { probeVersion: "0.2.0", commit: "x" });
    const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
    expect(spawnSync("node", [cli, "verify-lock", "--data-dir", d]).status).toBe(0);
    writeFileSync(join(d, "urls.csv"), "changed\n");
    expect(spawnSync("node", [cli, "verify-lock", "--data-dir", d]).status).toBe(1);
  });
});

describe("review page", () => {
  const records = [acc(1, "article", "a.com"), acc(2, "docs", "b.org"), exc(3, "article", "http-status-403", { screenshot: "/data/screens/x.jpg", detail: { http_status: 403, flags: ["http-error"] } }), exc(4, "forum", "language:de", { detail: { lang: "de", html_lang: "en-US", lang_top: ["de", "hu"] } }), exc(5, "forum", "domain-quota")];
  const html = buildReviewHtml(records, (r) => (r.screenshot ? r.screenshot.replace("/data/", "") : null), "2026-11-25T00:00:00Z");
  it("has the three sections, one card per accepted page grouped by category, an answer box and an export button", () => {
    expect(html).toContain('id="secA"');
    expect(html).toContain('id="secB"');
    expect(html).toContain('id="secC"');
    expect(html.match(/data-section="A"/g)).toHaveLength(2);
    expect(html).toContain('id="a-article"');
    expect(html).toContain('<option value="duvida">');
    expect(html).toContain('id="export"');
    expect(html).toContain("localStorage");
    expect(html).toContain("WCXB");
    expect(html).toContain("WebMainBench");
  });
  it("lists the first exclusions (B) and only the rule-decided ones in C", () => {
    expect(html.match(/data-section="B1"/g)).toHaveLength(3);
    expect(html.match(/data-section="B2"/g)).toHaveLength(1);
    expect(html.match(/data-section="C"/g)).toHaveLength(1);
    expect(isRuleDecided(records[3])).toBe(true);
    expect(isRuleDecided(records[4])).toBe(false);
  });
  it("is self-contained: images by relative path, no external resource, content escaped", () => {
    expect(html).toContain('src="screens/article-1.jpg"');
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img[^>]+src="(https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    expect(html).toContain("T &lt;1&gt;");
    expect(html).toContain("https://x3.example/a?b=1&amp;c=2");
  });
});
