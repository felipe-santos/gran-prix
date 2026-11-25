import { describe, expect, it } from "vitest";
import { htmlToMarkdown, isRenderedNode, effectiveOpacities, PageDom } from "../src/index.js";
import { fixture } from "./helpers.js";

const md = (body: string, opts: Parameters<typeof htmlToMarkdown>[2] = {}): string => {
  const f = fixture(body);
  return htmlToMarkdown(f.stored, f.nodes, opts).markdown;
};

describe("isRenderedNode (the rule of U)", () => {
  type Rect = { x: number; y: number; w: number; h: number };
  type Probe = { style: { display: string; visibility: string; opacity: number }; rect: Rect | null };
  const base: Probe = { style: { display: "block", visibility: "visible", opacity: 1 }, rect: { x: 10, y: 10, w: 100, h: 20 } };
  const cases: Array<[string, Partial<Probe>, number, boolean]> = [
    ["a normal box", {}, 1, true],
    ["display:none", { style: { ...base.style, display: "none" } }, 1, false],
    ["visibility:hidden", { style: { ...base.style, visibility: "hidden" } }, 1, false],
    ["visibility:collapse", { style: { ...base.style, visibility: "collapse" } }, 1, false],
    ["opacity 0 inherited from an ancestor", {}, 0, false],
    ["no rect (not laid out)", { rect: null }, 1, false],
    ["the 1x1 sr-only clip", { rect: { x: 0, y: 0, w: 1, h: 1 } }, 1, false],
    ["a zero-width box", { rect: { x: 0, y: 0, w: 0, h: 20 } }, 1, false],
    ["pushed off to the left (-9999px)", { rect: { x: -10000, y: 0, w: 100, h: 20 } }, 1, false],
    ["pushed above the page", { rect: { x: 0, y: -50, w: 100, h: 20 } }, 1, false],
    ["a 1px-wide but tall box is rendered (a rule, a divider)", { rect: { x: 0, y: 0, w: 1, h: 20 } }, 1, true],
  ];
  for (const [name, over, opacity, want] of cases) {
    it(name, () => expect(isRenderedNode({ ...base, ...over }, opacity)).toBe(want));
  }

  it("effective opacity is the product down the tree", () => {
    const nodes = [
      { parent: -1, style: { display: "block", visibility: "visible", opacity: 0.5 } },
      { parent: 0, style: { display: "block", visibility: "visible", opacity: 0.5 } },
      { parent: 1, style: { display: "block", visibility: "visible", opacity: 0 } },
    ];
    expect(Array.from(effectiveOpacities(nodes))).toEqual([0.5, 0.25, 0]);
  });
});

describe("D2: the whole page as markdown", () => {
  it("uses ATX headings, GFM tables and strikethrough, and turndown's defaults for the rest", () => {
    const out = md(`<h1>Title</h1><h2>Sub</h2><p>Some <strong>bold</strong> and <em>it</em> and <del>gone</del>.</p>
      <ul><li>one</li><li>two</li></ul>
      <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>`);
    expect(out).toBe(
      ["# Title", "", "## Sub", "", "Some **bold** and _it_ and ~gone~.", "", "*   one", "*   two", "", "| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n"),
    );
  });

  it("a table without a heading row stays raw HTML (turndown-plugin-gfm's rule), and never carries data-gp-*", () => {
    const out = md(`<table><tbody><tr><th>Material</th><td>Steel</td></tr><tr><th>Weight</th><td>340 g</td></tr></tbody></table>`);
    expect(out).toBe("<table><tbody><tr><th>Material</th><td>Steel</td></tr><tr><th>Weight</th><td>340 g</td></tr></tbody></table>");
  });

  it("removes script, style, noscript, template and svg wherever they are", () => {
    const out = md(
      `<p>keep</p><script>var x = 1;</script><style>p{color:red}</style><noscript><p>no js</p></noscript><template><p>tpl</p></template><svg><text>vector</text></svg><div><svg><title>t</title></svg><p>also</p></div>`,
    );
    expect(out).toBe("keep\n\nalso");
  });

  it("turns every image into ![alt]() with no URL and no data URI", () => {
    const out = md(
      `<p>a <img src="https://x.test/p.png" alt="A cat"> b <img src="data:image/png;base64,AAAA" alt="Inline"> c <img src="/n.png"></p><p><a href="/big"><img src="/t.png" alt="Linked"></a></p>`,
    );
    expect(out).toBe("a ![A cat]() b ![Inline]() c ![]()\n\n[![Linked]()](/big)");
    expect(out).not.toMatch(/data:|https:|\.png/);
  });

  it("drops what is not rendered: display:none, hidden subtrees, fully transparent, off-screen, the sr-only clip", () => {
    const out = md(
      `<p>visible</p>
       <div data-t-display="none"><p>gone one</p></div>
       <div data-t-opacity="0"><p data-t-opacity="1">gone two</p></div>
       <span data-t-rect="-9999,0,100,20">gone three</span>
       <span data-t-rect="0,0,1,1">gone four</span>
       <p data-t-visibility="hidden">gone five</p>
       <p>also visible</p>`,
    );
    expect(out).toBe("visible\n\nalso visible");
  });

  it("an unrendered image is gone (hidden, a 1x1 tracking pixel), a rendered one stays", () => {
    const out = md(`<p>x<img alt="pixel" data-t-rect="0,0,1,1"><img alt="hid" data-t-display="none"><img alt="shown"></p>`);
    expect(out).toBe("x![shown]()");
  });

  it("a hidden link leaves nothing behind (no empty [](#x)); a link whose text is hidden but whose child is shown keeps the child", () => {
    expect(md(`<p>a</p><a href="#c" data-t-rect="-9999,0,1,1">Skip to comments</a><p>b</p>`)).toBe("a\n\nb");
    expect(md(`<a href="/x" data-t-visibility="hidden">hidden text<img alt="logo" data-t-visibility="visible"></a>`)).toBe("[![logo]()](/x)");
  });

  it("an element whose own text is hidden loses that text but its visible children stay", () => {
    const out = md(`<div data-t-visibility="hidden">secret<p data-t-visibility="visible">child</p></div>`);
    expect(out).toBe("child");
  });

  it("a display:contents wrapper (no rect) keeps its children", () => {
    const out = md(`<div data-t-display="contents" data-t-rect="null"><p>inside</p></div>`);
    expect(out).toBe("inside");
  });

  it("collapsed disclosure content: excluded by default, kept with collapsed: include", () => {
    const body = `<details><summary>FAQ</summary><div data-t-disclosure data-t-rect="null" data-t-display="block"><p data-t-disclosure data-t-rect="null">Hidden answer</p></div></details><p>after</p>`;
    expect(md(body)).toBe("FAQ\n\nafter");
    expect(md(body, { collapsed: "exclude" })).toBe("FAQ\n\nafter");
    expect(md(body, { collapsed: "include" })).toBe("FAQ\n\nHidden answer\n\nafter");
  });

  it("is deterministic and a PageDom can be converted many times without changing", () => {
    const f = fixture(`<h1>T</h1><p>one</p><p data-t-display="none">two</p>`);
    const page = new PageDom(f.stored, f.nodes);
    const a = page.convert().markdown;
    const b = page.convert({ keep: new Set([f.one("h1")]) }).markdown;
    const c = page.convert().markdown;
    page.dispose();
    expect(a).toBe("# T\n\none");
    expect(b).toBe("# T");
    expect(c).toBe(a);
    expect(htmlToMarkdown(f.stored, f.nodes).markdown).toBe(a);
  });

  it("an element without a data-gp-id follows its parent and is counted", () => {
    const f = fixture(`<div><p>stamped</p></div>`);
    const stored = f.stored.replace("</div>", `<p>late</p></div>`); // unstamped
    const r = htmlToMarkdown(stored, f.nodes);
    expect(r.markdown).toBe("stamped\n\nlate");
    expect(r.unstamped).toBe(1);
  });
});
