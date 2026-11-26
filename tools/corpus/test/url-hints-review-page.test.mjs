import { describe, expect, it } from "vitest";
import { buildReviewHtml } from "../src/review-page.mjs";
import { normalizeUrl, urlChanged, urlHints } from "../src/url-hints.mjs";

const kinds = (a, b) => urlHints(a, b).map((h) => h.kind);

describe("urlChanged (selo)", () => {
  it("compares host without www. and path without the trailing slash; scheme, query and fragment do not count", () => {
    expect(normalizeUrl("https://WWW.Example.com/a/b/?x=1#y")).toEqual({ host: "example.com", path: "/a/b" });
    expect(urlChanged("http://www.a.com/x/", "https://a.com/x")).toBe(false);
    expect(urlChanged("https://a.com/x?s=1", "https://a.com/x?s=2#top")).toBe(false);
    expect(urlChanged("https://a.com", "https://a.com/")).toBe(false);
    expect(urlChanged("https://a.com/x", "https://a.com/y")).toBe(true);
    expect(urlChanged("https://a.com/x", "https://b.com/x")).toBe(true);
    expect(urlChanged("https://a.com/x", "https://sub.a.com/x")).toBe(true);
    expect(urlChanged("https://a.com/x", null)).toBe(false);
    expect(urlChanged("not a url", "https://a.com/")).toBe(false);
  });
});

describe("urlHints (dicas, não decisões)", () => {
  it("error: 404, not-found, error in the final URL", () => {
    expect(kinds("https://www.702.co.za/articles/1/x", "https://www.primediaplus.com/404/")).toEqual(["erro", "outro-site"]);
    expect(kinds("https://a.com/p/1", "https://a.com/not-found")).toContain("erro");
    expect(kinds("https://a.com/p/1", "https://a.com/not_found?x=1")).toContain("erro");
    expect(kinds("https://a.com/p/1", "https://a.com/error")).toContain("erro");
    expect(kinds("https://a.com/p/1", "https://a.com/terror-in-art")).not.toContain("erro");
    expect(kinds("https://a.com/p/1", "https://a.com/p/14040")).not.toContain("erro");
  });
  it("home: the final path is / and the requested one was not", () => {
    expect(kinds("https://videoguys.com/products/x", "https://videoguys.com/")).toEqual(["home"]);
    expect(kinds("https://www.rise.global/gurus/p/1", "https://rise.global/")).toEqual(["home"]);
    expect(kinds("https://a.com/", "https://a.com")).toEqual([]);
    expect(kinds("https://a.com/x", "https://a.com/en")).toEqual([]);
  });
  it("login / OAuth and challenge", () => {
    expect(kinds("https://www.gitionline.com/products/x", "https://www.gitionline.com/password")).toEqual(["login"]);
    expect(kinds("https://bigfuture.collegeboard.org/plan/x", "https://prod.idp.collegeboard.org/oauth2/aus3/v1/authorize?client_id=1")).toEqual(["login"]); // same eTLD+1: not "another site"
    expect(kinds("https://a.com/x", "https://a.com/signin")).toEqual(["login"]);
    expect(kinds("https://forums.debian.net/viewtopic.php?t=1", "https://forums.debian.net/app.php/anubis/api/make_challenge?redir=x")).toEqual(["desafio"]);
    expect(kinds("https://a.com/x", "https://a.com/cdn-cgi/challenge-platform/h/b")).toEqual(["desafio"]);
    expect(kinds("https://a.com/x", "https://a.com/x?__cf_chl_rt_tk=abc")).toEqual(["desafio"]);
    expect(kinds("https://a.com/x", "https://a.com/captcha")).toEqual(["desafio"]);
  });
  it("another site: the eTLD+1 changed (PSL with the private section)", () => {
    expect(kinds("https://www.popmalt.com/forums/t/x", "https://www.youtube.com/c/PopMalt")).toEqual(["outro-site"]);
    expect(kinds("http://lisle.patch.com/groups/x", "https://patch.com/illinois/lisle")).toEqual([]); // same eTLD+1
    expect(kinds("https://a.github.io/x", "https://b.github.io/x")).toEqual(["outro-site"]);
  });
  it("a token that was already in the requested URL is not a hint (the page was asked for it)", () => {
    expect(kinds("https://docs.a.com/guides/oauth", "https://docs.a.com/guides/oauth/overview")).toEqual([]);
    expect(kinds("https://a.com/blog/error-handling", "https://a.com/blog/error-handling-in-go")).toEqual([]);
  });
});

describe("review page: selo, dicas, motivo, filtro, export", () => {
  const acc = (seq, url, final, extra = {}) => ({ seq, category: "article", walk_category: "article", url, domain: "a.com", source_dataset: "wcxb", source_type: "article", phase: "primary", outcome: "accepted", reason: "ok", detail: { lang: "en", group_key: "a.com", visible_chars: 500, final_url: final }, set_entry: { snapshot_id: `sha256:s${seq}` }, ...extra });
  const records = [acc(1, "https://a.com/x", "https://a.com/x"), acc(2, "https://a.com/y", "https://a.com/404/"), acc(3, "https://a.com/z/", "https://www.a.com/z"), acc(4, "https://b.com/w", "https://b.com/")];
  const html = buildReviewHtml(records, () => null, "2026-11-26T00:00:00Z", { name: "corpus-v0.lock.json", sha256: "sha256:abc123" });

  it("shows requested and final URL, and the seal only where host or path changed", () => {
    expect(html.match(/class="seal"/g)).toHaveLength(2 + 1); // two cards + the legend in the summary
    expect(html).toContain("URL final ≠ pedida");
    expect(html).toContain('data-url="https://a.com/y"');
    expect(html).toContain("pedida");
    expect(html).toContain("final");
    expect(html).toMatch(/data-url="https:\/\/a\.com\/x"[^>]*data-seal="0"/);
    expect(html).toMatch(/data-url="https:\/\/a\.com\/y"[^>]*data-seal="1" data-hints="erro"/);
    expect(html).toMatch(/data-url="https:\/\/b\.com\/w"[^>]*data-seal="1" data-hints="home"/);
    expect(html).toMatch(/data-url="https:\/\/a\.com\/z\/"[^>]*data-seal="0"/); // www. and the trailing slash do not count
  });
  it("counts seals and hints at the top, says that doubt excludes, and has the filter", () => {
    expect(html).toContain("2 de 4 páginas aceitas têm o selo");
    expect(html).toMatch(/2 têm alguma dica \(erro 1, home 1\)/);
    expect(html).toContain("Dúvida conta como exclusão");
    expect(html).toContain('id="onlySeal"');
    expect(html).toContain("só as com selo");
  });
  it("the answer box has the reason field with its options, and sim is the default", () => {
    for (const t of ["categoria errada", "erro ou soft-404", ">login<", "desafio", "home ou listagem", "outro (texto)"]) expect(html).toContain(t);
    expect(html).toMatch(/<select class="ans"><option value="sim">sim \(padrão\)/);
    expect(html).toContain('class="why-text"');
  });
  it("the export carries snapshot id, url, category, answer, reason, note and the lock in force", () => {
    expect(html).toContain('FORMAT="gran-prix.corpus-review/1"');
    expect(html).toContain('LOCK_SHA="sha256:abc123"');
    for (const f of ["snapshot_id", "url:", "category:", "answer:", "reason:", "reason_text:", "note:", "lock_sha256:LOCK_SHA"]) expect(html).toContain(f);
    expect(html).toContain('data-snapshot="sha256:s2"');
  });
  it("without a lock the page says so and exports a null lock", () => {
    const h = buildReviewHtml(records, () => null, "2026-11-26T00:00:00Z");
    expect(h).toContain("nenhum (rode gp-corpus lock)");
    expect(h).toContain("LOCK_SHA=null");
  });
});
