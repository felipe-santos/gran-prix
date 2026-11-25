import { describe, expect, it } from "vitest";
import { htmlToMarkdown, planPage, ACT_CONTAINER, ACT_DROP, ACT_FULL } from "../src/index.js";
import { fixture, type Fixture } from "./helpers.js";

/** Pruned markdown of the elements matching `keepSelectors` (the units kept by a system). */
function pruned(body: string, keepSelectors: string[]): { out: string; f: Fixture } {
  const f = fixture(body);
  const keep = new Set(keepSelectors.flatMap((s) => f.idx(s)));
  return { out: htmlToMarkdown(f.stored, f.nodes, { keep }).markdown, f };
}

describe("pruned output: the same converter over the kept units plus the structure of their ancestors", () => {
  it("a list with ONE kept item keeps the list and that item, nothing else", () => {
    const { out } = pruned(`<h2>Menu</h2><ul><li id="a">alpha</li><li id="b">beta</li><li id="c">gamma</li></ul>`, ["#b"]);
    expect(out).toBe("*   beta");
  });

  it("a list with its first and last items kept leaves the middle out", () => {
    const { out } = pruned(`<ul><li id="a">alpha</li><li id="b">beta</li><li id="c">gamma</li></ul>`, ["#a", "#c"]);
    expect(out).toBe("*   alpha\n*   gamma");
  });

  it("a table with ONE kept row (header and that row) is a valid GFM table of two rows", () => {
    const body = `<table><thead><tr><th id="h1">Name</th><th id="h2">Qty</th></tr></thead><tbody>
      <tr id="r1"><td>apple</td><td>1</td></tr><tr id="r2"><td id="c1">pear</td><td id="c2">2</td></tr><tr id="r3"><td>plum</td><td>3</td></tr></tbody></table>`;
    const { out } = pruned(body, ["#h1", "#h2", "#c1", "#c2"]);
    expect(out).toBe("| Name | Qty |\n| --- | --- |\n| pear | 2 |");
  });

  it("known consequences of turndown on a pruned DOM: an <ol> renumbers; a table whose header is not kept has no heading row", () => {
    expect(pruned(`<ol><li id="a">one</li><li id="b">two</li><li id="c">three</li></ol>`, ["#c"]).out).toBe("1.  three");
    const t = pruned(`<table><thead><tr><th>Name</th></tr></thead><tbody><tr><td id="a">apple</td></tr><tr><td>pear</td></tr></tbody></table>`, ["#a"]).out;
    expect(t).toBe('<table><tbody><tr><td id="a">apple</td></tr></tbody></table>'); // raw HTML (the page's own id stays; data-gp-* does not): the GFM plugin only converts tables with a heading row
  });

  it("a kept title with the body removed is the title alone (the article container stays as structure)", () => {
    const { out } = pruned(`<article><h1 id="t">The title</h1><p>The long body that is noise.</p><p>More noise.</p></article>`, ["#t"]);
    expect(out).toBe("# The title");
  });

  it("a kept link inside a removed paragraph: the paragraph is only a container, its own text goes", () => {
    const { out } = pruned(`<p id="p">Read the <a id="l" href="/guide">full guide</a> before you start.</p><p>other</p>`, ["#l"]);
    expect(out).toBe("[full guide](/guide)");
  });

  it("a kept element keeps its own text AND is a container of the kept ones below it", () => {
    const { out } = pruned(`<p id="p">Read the <a id="l" href="/g">guide</a> now.</p>`, ["#p", "#l"]);
    expect(out).toBe("Read the [guide](/g) now.");
  });

  it("a non-kept unit between kept ones is dropped with its subtree", () => {
    const { out } = pruned(`<div><p id="a">first</p><div id="ad"><p>an ad</p><a href="/x">buy</a></div><p id="b">last</p></div>`, ["#a", "#b"]);
    expect(out).toBe("first\n\nlast");
  });

  it("decoration of a kept element (br, img without text, wrapper spans) stays; decoration of a container does not", () => {
    const { out } = pruned(`<div><img alt="logo"><p id="a">line one<br>line two <span><img alt="icon"></span></p></div>`, ["#a"]);
    expect(out).toBe("line one  \nline two ![icon]()");
  });

  it("an empty keep set is an empty output", () => {
    expect(pruned(`<h1>T</h1><p>x</p>`, []).out).toBe("");
  });

  it("a kept unit that is not rendered emits nothing (the render filter comes first)", () => {
    const { out } = pruned(`<p id="a" data-t-display="none">hidden</p><p id="b" data-t-visibility="hidden">hidden too</p><p id="c">shown</p>`, ["#a", "#b", "#c"]);
    expect(out).toBe("shown");
  });

  it("a kept disclosure unit is emitted only with collapsed: include", () => {
    const f = fixture(`<details><summary id="s">Q</summary><p id="a" data-t-disclosure data-t-rect="null">A</p></details>`);
    const keep = new Set([...f.idx("#s"), ...f.idx("#a")]);
    expect(htmlToMarkdown(f.stored, f.nodes, { keep }).markdown).toBe("Q");
    expect(htmlToMarkdown(f.stored, f.nodes, { keep, collapsed: "include" }).markdown).toBe("Q\n\nA");
  });

  it("keeping every rendered unit gives the whole-page markdown (the oracle that keeps all is D2)", () => {
    const f = fixture(`<h1>T</h1><p>one <a href="/x">two</a></p><ul><li>a</li><li>b</li></ul><p data-t-display="none">hid</p>`);
    const units = f.nodes.filter((n) => n.own_text_len > 0).map((n) => n.idx);
    const all = htmlToMarkdown(f.stored, f.nodes, { keep: new Set(units) }).markdown;
    expect(all).toBe(htmlToMarkdown(f.stored, f.nodes).markdown);
  });

  it("the plan, element by element", () => {
    const f = fixture(`<div id="d"><p id="p">own <a id="a" href="/x">link</a></p><p id="q">other</p><img id="i" alt="x"></div>`);
    const plan = planPage(f.nodes, { collapsed: "exclude", keep: new Set(f.idx("#a")) });
    const act = (s: string): number => plan.act[f.one(s)] as number;
    expect(act("#a")).toBe(ACT_FULL);
    expect(act("#p")).toBe(ACT_CONTAINER);
    expect(act("#d")).toBe(ACT_CONTAINER);
    expect(act("body")).toBe(ACT_CONTAINER);
    expect(act("#q")).toBe(ACT_DROP);
    expect(act("#i")).toBe(ACT_DROP); // decoration of a container, not of a kept element
  });
});
