import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildFrame, classifyWmb, jsonLdTypes } from "../src/frame.mjs";
import { byOrderHash, etld1, orderHash } from "../src/hash.mjs";

describe("order hash (§2.3.2)", () => {
  it("is sha256 of the frozen prefix plus the url", () => {
    const url = "https://example.com/a";
    expect(orderHash(url)).toBe(createHash("sha256").update("gp-dom-v0|20261125|https://example.com/a").digest("hex"));
    expect(orderHash(url)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("sorts ascending, ties broken by url", () => {
    const rows = [{ order_hash: "b", url: "x" }, { order_hash: "a", url: "z" }, { order_hash: "a", url: "y" }];
    expect(rows.sort(byOrderHash).map((r) => r.url)).toEqual(["y", "z", "x"]);
  });
});

describe("eTLD+1 with the private PSL section", () => {
  it("keeps github.io and blogspot.com subdomains apart, collapses ordinary subdomains", () => {
    expect(etld1("https://alice.github.io/post")).toBe("alice.github.io");
    expect(etld1("https://bob.github.io/")).toBe("bob.github.io");
    expect(etld1("https://docs.python.org/3/")).toBe("python.org");
    expect(etld1("https://www.bbc.co.uk/news")).toBe("bbc.co.uk");
    expect(etld1("https://x.blogspot.com/")).toBe("x.blogspot.com");
  });
});

describe("frame", () => {
  const w = (id, page_type, url, spa = false) => ({ file_id: id, page_type, spa, url });
  it("maps WCXB types, drops listing/collection, routes SPA-flagged pages to spa", () => {
    const { rows, stats } = buildFrame(
      [
        w("1", "article", "https://a.com/1"),
        w("2", "documentation", "https://b.com/2"),
        w("3", "service", "https://c.com/3"),
        w("4", "listing", "https://d.com/4"),
        w("5", "collection", "https://e.com/5"),
        w("6", "product", "https://f.com/6", true),
        w("7", "forum", ""),
        w("8", "listing", "https://g.com/8", true),
      ],
      [],
    );
    const cat = Object.fromEntries(rows.map((r) => [r.url, r.category]));
    expect(cat).toEqual({ "https://a.com/1": "article", "https://b.com/2": "docs", "https://c.com/3": "landing", "https://f.com/6": "spa" });
    expect(stats.wcxb_dropped_type).toEqual({ listing: 2, collection: 1 });
    expect(stats.wcxb_missing_url).toBe(1);
    expect(rows.every((r, i) => i === 0 || rows[i - 1].order_hash <= r.order_hash)).toBe(true);
    expect(rows[0]).toMatchObject({ source_dataset: "wcxb", order_hash: orderHash(rows[0].url) });
  });
  it("WebMainBench only adds URLs WCXB lacks, classified by JSON-LD or URL rule", () => {
    const { rows, stats } = buildFrame(
      [w("1", "article", "https://a.com/1")],
      [
        { track_id: "t1", url: "https://a.com/1", jsonld_types: ["Product"] },
        { track_id: "t2", url: "https://shop.example/p1", jsonld_types: ["Product"] },
        { track_id: "t3", url: "https://docs.example.org/guide", jsonld_types: [] },
        { track_id: "t4", url: "https://example.net/about", jsonld_types: [] },
      ],
    );
    expect(rows.map((r) => r.url).sort()).toEqual(["https://a.com/1", "https://docs.example.org/guide", "https://shop.example/p1"]);
    expect(stats).toMatchObject({ wmb_already_in_wcxb: 1, wmb_added: 2, wmb_unclassified: 1 });
  });
  it("classifyWmb and jsonLdTypes", () => {
    expect(classifyWmb({ url: "https://x.com/forum/thread/1", jsonld_types: [] })).toBe("forum");
    expect(classifyWmb({ url: "https://x.com/news/1", jsonld_types: ["NewsArticle"] })).toBe("article");
    expect(classifyWmb({ url: "https://x.com/", jsonld_types: [] })).toBeNull();
    const html = '<script type="application/ld+json">{"@graph":[{"@type":"Product"},{"@type":["WebPage","Article"]}]}</script><script type="application/ld+json">{bad</script>';
    expect(jsonLdTypes(html).sort()).toEqual(["Article", "Product", "WebPage"]);
  });
});
