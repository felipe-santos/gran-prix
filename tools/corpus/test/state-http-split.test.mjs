import { describe, expect, it } from "vitest";
import { PoliteHttp } from "../src/http.mjs";
import { first20Markdown, summarize, urlsCsv } from "../src/report.mjs";
import { PREREG_RANGES, firstSalt, satisfies, splitCounts } from "../src/split.mjs";
import { WalkState, effectiveRecords, nonEnCap } from "../src/state.mjs";
import { CATEGORIES } from "../src/config.mjs";

const acc = (category, domain, lang = "en", extra = {}) => ({ outcome: "accepted", category, walk_category: category, url: `https://${domain}/${category}`, domain, seq: 1, detail: { lang, group_key: domain }, ...extra });

describe("WalkState quotas (§2.2)", () => {
  it("1 per (domain, category) and 2 per domain", () => {
    const s = WalkState.replay([acc("article", "a.com")]);
    expect(s.quotaReason("article", "a.com")).toBe("domain-category-quota");
    expect(s.quotaReason("product", "a.com")).toBeNull();
    s.accept(acc("product", "a.com"));
    expect(s.quotaReason("docs", "a.com")).toBe("domain-quota");
    expect(s.quotaReason("docs", "b.com")).toBeNull();
  });
  it("language cap per category is floor(30%) of the target", () => {
    expect(nonEnCap("article")).toBe(9);
    expect(nonEnCap("landing")).toBe(7);
    const s = new WalkState();
    for (let i = 0; i < 9; i++) s.accept(acc("article", `d${i}.com`, "pt"));
    expect(s.languageReason("article", "es")).toBe("language-cap");
    expect(s.languageReason("article", "en")).toBeNull();
    expect(s.languageReason("product", "es")).toBeNull();
  });
  it("replay marks walked keys, so a resumed run skips them", () => {
    const s = WalkState.replay([{ outcome: "excluded", category: "docs", walk_category: "docs", url: "https://x.com/d" }]);
    expect(s.walked.has(WalkState.key("docs", "https://x.com/d"))).toBe(true);
  });
});

describe("effectiveRecords", () => {
  it("a later record of the same (category, url) supersedes the earlier one; other categories are independent", () => {
    const recs = [
      { category: "spa", url: "https://a.com/", seq: 1, outcome: "excluded", reason: "capture" },
      { category: "forum", url: "https://a.com/", seq: 2, outcome: "excluded", reason: "x" },
      { category: "spa", url: "https://a.com/", seq: 3, outcome: "accepted", reason: "ok", supersedes: 1 },
    ];
    expect(effectiveRecords(recs).map((r) => r.seq)).toEqual([2, 3]);
    const s = WalkState.replay(effectiveRecords(recs).map((r) => ({ ...r, walk_category: r.category, domain: "a.com", detail: { lang: "en", group_key: "a.com" } })));
    expect(s.count("spa")).toBe(1);
  });
});

describe("PoliteHttp", () => {
  const res = (status, body = "") => ({ status, url: "https://h.example/robots.txt", headers: new Headers(), body: (async function* () { yield Buffer.from(body); })() });
  it("robots: Disallow honoured for our token, 404 = allow, 5xx = unavailable (disallow)", async () => {
    const mk = (status, body) => new PoliteHttp({ hostDelayMs: 0, fetchImpl: async () => res(status, body) });
    const dis = await mk(200, "User-agent: *\nDisallow: /private").robotsAllows("https://h.example/private/x");
    expect(dis).toMatchObject({ allowed: false, state: "ok" });
    expect((await mk(200, "User-agent: *\nDisallow: /private").robotsAllows("https://h.example/public")).allowed).toBe(true);
    expect(await mk(404, "").robotsAllows("https://h.example/a")).toMatchObject({ allowed: true, state: "none" });
    expect(await mk(503, "").robotsAllows("https://h.example/a")).toMatchObject({ allowed: false, state: "unavailable" });
  });
  it("serialises requests per host with a minimum delay", async () => {
    const times = [];
    const http = new PoliteHttp({ hostDelayMs: 60, fetchImpl: async () => { times.push(Date.now()); return res(200, "x"); } });
    await Promise.all([http.get("https://h.example/1"), http.get("https://h.example/2"), http.get("https://h.example/3")]);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(55);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(55);
  });
});

describe("split check (§3)", () => {
  it("uses the pre-registered ranges, not the contracts' defaults", () => {
    expect(PREREG_RANGES).toEqual({ train: [0, 55], val: [55, 70], test: [70, 100] });
  });
  const pages = CATEGORIES.flatMap((c) => Array.from({ length: c.n }, (_, k) => ({ category: c.name, group_key: `${c.name}-${k}.example` })));
  it("is deterministic and partitions every page", () => {
    const a = splitCounts(pages, "gp-dom-v0-s0");
    expect(splitCounts(pages, "gp-dom-v0-s0")).toEqual(a);
    for (const c of CATEGORIES) expect(a[c.name].train + a[c.name].val + a[c.name].test).toBe(c.n);
  });
  it("firstSalt can restrict the rule to some categories (the indicative i), and fails when an incomplete one is included", () => {
    const some = pages.filter((p) => p.category !== "spa").concat(pages.filter((p) => p.category === "spa").slice(0, 5));
    expect(firstSalt(some).i).toBeNull();
    const only = ["article", "product", "docs", "forum", "landing"];
    const r = firstSalt(some, 1000, only);
    expect(r.i).not.toBeNull();
    expect(satisfies(r.counts, only)).toBe(true);
    expect(satisfies(r.counts)).toBe(false);
  });
  it("the amended rule (registered deviation) relaxes only spa: >= 3 test and >= 6 dev, the rest as pre-registered", () => {
    const twelve = pages.filter((p) => p.category !== "spa").concat(pages.filter((p) => p.category === "spa").slice(0, 12));
    const r = firstSalt(twelve, 1000, undefined, true);
    expect(r.i).not.toBeNull();
    expect(satisfies(r.counts, undefined, true)).toBe(true);
    expect(r.counts.spa.test).toBeGreaterThanOrEqual(3);
    expect(r.counts.spa.dev).toBeGreaterThanOrEqual(6);
    for (const c of ["article", "product", "docs", "forum", "landing"]) {
      expect(r.counts[c].test).toBeGreaterThanOrEqual(6);
      expect(r.counts[c].dev).toBeGreaterThanOrEqual(17);
    }
    for (const t of r.tried.slice(0, -1)) expect(satisfies(t.counts, undefined, true)).toBe(false);
    // without the amendment the same corpus has no admissible salt
    expect(firstSalt(twelve).i).toBeNull();
  });
  it("firstSalt returns the first i that satisfies the rule", () => {
    const r = firstSalt(pages);
    expect(r.i).not.toBeNull();
    expect(satisfies(r.counts)).toBe(true);
    for (const t of r.tried.slice(0, -1)) expect(t.ok).toBe(false);
  });
});

describe("report outputs", () => {
  const recs = [
    { ...acc("article", "a.com"), seq: 1, set_entry: {} },
    { outcome: "excluded", category: "article", reason: "http-status-403", url: "https://b.com/x,y", seq: 2, detail: { http_status: 403 }, also: [], screenshot: "/d/screens/a.jpg" },
    { outcome: "excluded", category: "product", reason: "domain-quota", url: "https://c.com/", seq: 3 },
  ];
  it("urls.csv has the gp run header and quotes commas", () => {
    const csv = urlsCsv([{ ...acc("docs", "d.com"), url: "https://d.com/a,b" }]);
    expect(csv).toBe('url,stratum,group_key\n"https://d.com/a,b",docs,d.com\n');
  });
  it("summary counts reasons per category; first-20 lists flag exclusions with screenshots", () => {
    const s = summarize(recs);
    expect(s.categories.article).toMatchObject({ accepted: 1, excluded: 1, by_reason: { "http-status-<code>": 1 } });
    expect(s.totals).toMatchObject({ accepted: 1, excluded: 2 });
    const md = first20Markdown(recs, "/d");
    expect(md).toContain("screens/a.jpg");
    expect(md).toContain("owner verdict");
    expect(md.split("## B.")[1]).not.toContain("domain-quota");
  });
});
