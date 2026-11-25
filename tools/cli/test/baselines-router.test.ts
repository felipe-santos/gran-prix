// The page-type router's fixed rules: the decision table of `predictPageType`, the a priori extractor table and
// the fallback usability rule. Pure functions: no Python, no browser.
import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTER_TABLE, FALLBACK_ORDER, PAGE_TYPES, predictPageType, type PageSignals, type PageType } from "../src/stages/baselines/router-rules.js";
import { usable } from "../src/stages/baselines/label-baselines.js";

type Case = [name: string, signals: PageSignals, type: PageType, signal: "jsonld" | "og:type" | "url" | "none"];

const U = "https://example.com/";
const TABLE: Case[] = [
  // JSON-LD @type decides first
  ["NewsArticle", { url: U, jsonld_types: ["NewsArticle"] }, "article", "jsonld"],
  ["BlogPosting with schema.org prefix", { url: U, jsonld_types: ["https://schema.org/BlogPosting"] }, "article", "jsonld"],
  ["Product", { url: U, jsonld_types: ["Product"] }, "product", "jsonld"],
  ["DiscussionForumPosting", { url: U, jsonld_types: ["DiscussionForumPosting"] }, "forum", "jsonld"],
  ["QAPage", { url: U, jsonld_types: ["QAPage", "Question"] }, "forum", "jsonld"],
  ["TechArticle is docs, not article", { url: U, jsonld_types: ["TechArticle"] }, "docs", "jsonld"],
  ["SoftwareApplication", { url: U, jsonld_types: ["SoftwareApplication"] }, "landing", "jsonld"],
  ["priority: Product beats Article on the same page", { url: U, jsonld_types: ["Article", "Product"] }, "product", "jsonld"],
  ["priority: forum beats product", { url: U, jsonld_types: ["Product", "DiscussionForumPosting"] }, "forum", "jsonld"],
  ["case-insensitive", { url: U, jsonld_types: ["newsarticle"] }, "article", "jsonld"],
  ["JSON-LD wins over og:type and URL", { url: "https://x.com/blog/post", og_type: "article", jsonld_types: ["Product"] }, "product", "jsonld"],
  ["unmapped JSON-LD falls through to og:type", { url: U, og_type: "article", jsonld_types: ["WebSite", "BreadcrumbList"] }, "article", "og:type"],
  // og:type
  ["og:type article", { url: U, og_type: "article" }, "article", "og:type"],
  ["og:type product", { url: U, og_type: "product" }, "product", "og:type"],
  ["og:type product.item", { url: U, og_type: "Product.Item" }, "product", "og:type"],
  ["og:type website carries no information", { url: "https://example.com/some/page.html", og_type: "website" }, "unknown", "none"],
  ["og:type wins over URL", { url: "https://example.com/forum/thread/1", og_type: "article" }, "article", "og:type"],
  // URL rules
  ["forum host", { url: "https://www.reddit.com/r/x/comments/1" }, "forum", "url"],
  ["forum host stackoverflow", { url: "https://stackoverflow.com/questions/1/x" }, "forum", "url"],
  ["forum path /threads/", { url: "https://example.com/threads/12-title" }, "forum", "url"],
  ["forum subdomain", { url: "https://forum.example.com/t/topic" }, "forum", "url"],
  ["docs subdomain", { url: "https://docs.example.com/start" }, "docs", "url"],
  ["docs path /docs/", { url: "https://example.com/docs/api/auth" }, "docs", "url"],
  ["docs readthedocs", { url: "https://proj.readthedocs.io/en/latest/" }, "docs", "url"],
  ["product path", { url: "https://shop.example.com/products/red-shoe" }, "product", "url"],
  ["article path /blog/", { url: "https://example.com/blog/hello-world" }, "article", "url"],
  ["article dated path", { url: "https://example.com/2025/09/04/some-title" }, "article", "url"],
  ["landing: site root", { url: "https://example.com/" }, "landing", "url"],
  ["landing: /pricing", { url: "https://example.com/pricing" }, "landing", "url"],
  ["no signal at all", { url: "https://example.com/some/page.html" }, "unknown", "none"],
  ["unparseable URL does not throw", { url: "not a url" }, "unknown", "none"],
  ["empty signals", { url: U, og_type: "", jsonld_types: [] }, "landing", "url"],
  ["file URLs (fixtures) carry no type", { url: "file:///repo/fixtures/pages/forum-1.html" }, "unknown", "none"],
];

describe("page-type router: decision table (rules fixed a priori in code)", () => {
  for (const [name, signals, type, signal] of TABLE) {
    it(name, () => {
      expect(predictPageType(signals)).toMatchObject({ type, signal });
    });
  }

  it("is a pure function of the signals (same input, same output; the page text never enters)", () => {
    for (const [, s] of TABLE) expect(predictPageType(s)).toEqual(predictPageType({ ...s }));
  });

  it("the a priori table covers every page type with a known extractor, and every Trafilatura entry has a mode", () => {
    for (const t of PAGE_TYPES) {
      const c = DEFAULT_ROUTER_TABLE[t];
      expect(["trafilatura", "defuddle", "readability"], t).toContain(c.extractor);
      if (c.extractor === "trafilatura") expect(["precision", "default", "recall"], t).toContain(c.mode);
    }
    expect(DEFAULT_ROUTER_TABLE.forum).toEqual({ extractor: "trafilatura", mode: "recall" });
    expect(DEFAULT_ROUTER_TABLE.article).toEqual({ extractor: "trafilatura", mode: "default" });
  });

  it("falls back in a fixed order: Trafilatura(default), Defuddle, Readability", () => {
    expect(FALLBACK_ORDER.map((c) => c.extractor)).toEqual(["trafilatura", "defuddle", "readability"]);
  });
});

describe("router fallback: when an extractor's labels are usable", () => {
  const doc = (alignment: Record<string, unknown>) => ({ alignment }) as never;
  it("needs output and at least 90% of it explained by the page", () => {
    expect(usable(doc({ status: "ok", coverage: 1, output_chars: 100 }))).toBe(true);
    expect(usable(doc({ status: "ok", coverage: 0.9, output_chars: 100 }))).toBe(true);
    expect(usable(doc({ status: "ok", coverage: 0.89, output_chars: 100 }))).toBe(false);
    expect(usable(doc({ status: "ok", coverage: 0, output_chars: 0 }))).toBe(false); // empty output scored with min_coverage 0
    expect(usable(doc({ status: "no-output", coverage: 0, output_chars: 0 }))).toBe(false);
    expect(usable(doc({ status: "no-article", coverage: 0 }))).toBe(false); // Readability returned null
    expect(usable(doc({ status: "ok", coverage: 1 }))).toBe(true); // Readability documents carry no output_chars
  });
});
