// flags.disclosure: content inside a COLLAPSED disclosure (closed <details>, aria-expanded=false region, inactive
// tabpanel, hidden=until-found) is flagged; visible content and content hidden for another reason is not.
import { validate } from "@gran-prix/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { featureSchemaV0, launch, probeLoadedPage, vectorize, type Launched, type RawProbe } from "../src/index.js";
import { captureFixture, fixtureNames } from "./helpers/capture.js";

let launched: Launched;
beforeAll(async () => { launched = await launch(); });
afterAll(async () => { await launched?.browser.close(); });

async function probeHtml(body: string, css = ""): Promise<RawProbe> {
  const html = `<!doctype html><html><head><title>t</title><style>${css}</style></head><body>${body}</body></html>`;
  const page = await launched.context.newPage();
  try {
    await page.route("https://fixture.test/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: html }));
    await page.goto("https://fixture.test/p", { waitUntil: "load" });
    return (await probeLoadedPage(page, { quietMs: 100 })).raw;
  } finally {
    await page.close();
  }
}

/** ids (attribute id) of the nodes carrying the flag */
const flagged = (raw: RawProbe): string[] => raw.nodes.filter((n) => n.flags.disclosure === true).map((n) => n.attrs.id ?? n.tag);
const node = (raw: RawProbe, id: string) => raw.nodes.find((n) => n.attrs.id === id)!;

describe("(a) closed <details>", () => {
  const body = `<details id="d"><summary id="s">Q</summary><p id="p">hidden answer <b id="b">bold</b></p><ul id="ul"><li id="li">item</li></ul></details>
    <details open id="o"><summary id="os">Q2</summary><p id="op">open answer</p></details>`;
  it("flags everything under a closed details except its summary; open details stay unflagged", async () => {
    const raw = await probeHtml(body);
    expect(flagged(raw)).toEqual(["p", "b", "ul", "li"]);
    expect(node(raw, "s").flags.disclosure).toBeUndefined();
    expect(node(raw, "d").flags.disclosure).toBeUndefined();
    expect(node(raw, "op").flags.disclosure).toBeUndefined();
  });
  it("flags a nested closed details inside an open one, and the open one inside a closed one (by inheritance)", async () => {
    const raw = await probeHtml(`<details open id="o"><summary>S</summary><details id="in"><summary id="is">S2</summary><p id="ip">x</p></details></details>
      <details id="c"><summary>S3</summary><details open id="co"><summary id="cos">S4</summary><p id="cop">y</p></details></details>`);
    expect(flagged(raw)).toEqual(["ip", "co", "cos", "cop"]);
  });
  it("does not flag a child that is hidden for another reason (own display:none) nor its subtree", async () => {
    const raw = await probeHtml(`<details><summary>S</summary><p id="ok">kept</p><div id="gone" hidden><p id="gone-p">draft</p></div></details>`);
    expect(flagged(raw)).toEqual(["ok"]);
  });
  it("does not flag a details that is itself not on screen (inside display:none or off-screen)", async () => {
    const raw = await probeHtml(`<div id="m" style="display:none"><details><summary>S</summary><p id="a">a</p></details></div>
      <div style="position:absolute;left:-9999px"><details><summary>S</summary><p id="b">b</p></details></div>`);
    expect(flagged(raw)).toEqual([]);
  });
});

describe("(b) aria-expanded=false + aria-controls", () => {
  it("flags the controlled element (hidden attribute, CSS display:none, max-height:0) and its descendants, not the control", async () => {
    const raw = await probeHtml(
      `<button id="b1" aria-expanded="false" aria-controls="p1">One</button><div id="p1" hidden><p id="p1t">one text</p></div>
       <button id="b2" aria-expanded="false" aria-controls="p2">Two</button><div id="p2" class="gone"><p id="p2t">two text</p></div>
       <button id="b3" aria-expanded="false" aria-controls="p3">Three</button><div id="p3" class="clip"><p id="p3t">three text</p></div>`,
      ".gone{display:none}.clip{max-height:0;overflow:hidden}",
    );
    expect(flagged(raw)).toEqual(["p1", "p1t", "p2", "p2t", "p3", "p3t"]);
  });
  it("one control can name several ids; aria-expanded=true and a visible target are not collapsed", async () => {
    const raw = await probeHtml(
      `<button aria-expanded="false" aria-controls="a b">T</button><div id="a" hidden>x</div><div id="b" hidden>y</div>
       <button aria-expanded="true" aria-controls="c">T</button><div id="c" hidden>z</div>
       <button aria-expanded="false" aria-controls="d">T</button><div id="d"><p id="dp">visible although the button says false</p></div>`,
    );
    expect(flagged(raw)).toEqual(["a", "b"]);
  });
  it("does not flag popups: aria-haspopup, dialog/menu roles, <nav>, fixed overlays, [popover]", async () => {
    const raw = await probeHtml(
      `<button aria-haspopup="dialog" aria-expanded="false" aria-controls="m1">a</button><div id="m1" hidden>one</div>
       <button aria-expanded="false" aria-controls="m2">b</button><div id="m2" role="dialog" hidden>two</div>
       <button aria-expanded="false" aria-controls="m3">c</button><nav id="m3" hidden><a href="#">three</a></nav>
       <button aria-expanded="false" aria-controls="m4">d</button><div id="m4" style="position:fixed;display:none">four</div>
       <button aria-expanded="false" aria-controls="m5">e</button><div id="m5" role="menu" hidden><span id="m5i">five</span></div>
       <button aria-expanded="false" aria-controls="m6">f</button><div id="m6" popover>six</div>`,
    );
    expect(flagged(raw)).toEqual([]);
  });
  it("does not flag a control that is not on screen (an off-screen ad, a hidden modal)", async () => {
    const raw = await probeHtml(
      `<div style="position:absolute;left:-9999px"><button aria-expanded="false" aria-controls="x">T</button><div id="x" hidden>ad text</div></div>
       <div style="display:none"><button aria-expanded="false" aria-controls="y">T</button><div id="y" hidden>modal text</div></div>`,
    );
    expect(flagged(raw)).toEqual([]);
  });
  it("resolves aria-controls inside a shadow tree", async () => {
    const raw = await probeHtml(`<div id="h"></div><script>
      const r = document.getElementById('h').attachShadow({mode:'open'});
      r.innerHTML = '<button aria-expanded="false" aria-controls="sp">T</button><div id="sp" hidden><p id="spt">shadow text</p></div>';</script>`);
    expect(flagged(raw)).toEqual(["sp", "spt"]);
    expect(node(raw, "spt").flags.in_shadow).toBe(true);
  });
});

describe("(c) inactive role=tabpanel", () => {
  const tabs = (sel: string): string => `<div role="tablist"><button role="tab" id="t1" aria-selected="${sel === "1"}" aria-controls="p1">A</button><button role="tab" id="t2" aria-selected="${sel === "2"}" aria-controls="p2">B</button></div>
    <div role="tabpanel" id="p1" aria-labelledby="t1" ${sel === "1" ? "" : "hidden"}><p id="p1t">first</p></div>
    <div role="tabpanel" id="p2" aria-labelledby="t2" ${sel === "2" ? "" : "hidden"}><p id="p2t">second</p></div>`;
  it("flags the panel whose tab is not selected, with its descendants; the active panel is not flagged", async () => {
    expect(flagged(await probeHtml(tabs("1")))).toEqual(["p2", "p2t"]);
    expect(flagged(await probeHtml(tabs("2")))).toEqual(["p1", "p1t"]);
  });
  it("finds the tab by aria-controls alone, and by a sibling active panel when there is no tab at all", async () => {
    const byControls = await probeHtml(`<button role="tab" aria-selected="false" aria-controls="q">T</button><div role="tabpanel" id="q" hidden><p id="qt">x</p></div>`);
    expect(flagged(byControls)).toEqual(["q", "qt"]);
    const bySibling = await probeHtml(`<div><div role="tabpanel" id="on"><p>on</p></div><div role="tabpanel" id="off" hidden><p id="offt">off</p></div></div>`);
    expect(flagged(bySibling)).toEqual(["off", "offt"]);
  });
  it("does not flag a hidden tabpanel whose tab is selected, or with no tab and no active sibling", async () => {
    const raw = await probeHtml(`<button role="tab" aria-selected="true" aria-controls="z">T</button><div role="tabpanel" id="z" hidden>broken</div>
      <div><div role="tabpanel" id="lonely" hidden>lonely</div></div>`);
    expect(flagged(raw)).toEqual([]);
  });
  it("does not flag a tabpanel inside a hidden modal", async () => {
    const raw = await probeHtml(`<div style="display:none">${tabs("1")}</div>`);
    expect(flagged(raw)).toEqual([]);
  });
});

describe("(d) hidden=until-found", () => {
  it("flags the element (visible itself, contents skipped) and its descendants; plain hidden is not a disclosure", async () => {
    const raw = await probeHtml(`<div id="u" hidden="until-found"><p id="ut">found by search</p></div><div id="h" hidden><p id="ht">plain hidden</p></div>`);
    expect(flagged(raw)).toEqual(["u", "ut"]);
  });
  it("is case-insensitive and ignores an until-found element inside a hidden container", async () => {
    const raw = await probeHtml(`<div id="u" hidden="UNTIL-FOUND"><p id="ut">x</p></div><div style="display:none"><div hidden="until-found"><p id="no">y</p></div></div>`);
    expect(flagged(raw)).toEqual(["u", "ut"]);
  });
});

describe("visible and otherwise-hidden content is never flagged", () => {
  it("plain page: nothing is flagged and no node carries the key (snapshot ids of pages without disclosure do not change)", async () => {
    const raw = await probeHtml(`<p id="a">text</p><div style="display:none"><p>hidden modal</p></div><div style="position:absolute;left:-9999px">ad</div><span style="opacity:0">x</span><div style="visibility:hidden">y</div>`);
    expect(flagged(raw)).toEqual([]);
    for (const n of raw.nodes) expect(Object.keys(n.flags).sort()).toEqual(["iframe_depth", "in_shadow"]);
  });
});

describe("fixtures/pages/docs-3.html (all four patterns + negatives)", () => {
  it("flags exactly the collapsed content, validates against the contract, and the control/summary are not flagged", async () => {
    const c = await captureFixture(launched, "docs-3");
    expect(validate("page-snapshot", c.snapshot).issues).toEqual([]);
    const nodes = c.snapshot.nodes;
    const text = (n: (typeof nodes)[number]): string => n.own_text;
    const byText = (frag: string) => nodes.find((n) => text(n).includes(frag));
    const isFlag = (frag: string): boolean | undefined => byText(frag)?.flags.disclosure;
    // (a) closed <details>: content and nested closed details yes; summaries, open details no; own display:none no
    expect(isFlag("Check that the proxy allows long-lived")).toBe(true);
    expect(isFlag("Raise the idle timeout")).toBe(true);
    expect(isFlag("How do I see the open stream?")).toBe(true); // nested details sits inside the collapsed one
    expect(isFlag("Run the relay with the")).toBe(true);
    expect(isFlag("A proxy that inspects traffic")).toBe(true);
    expect(isFlag("The relay starts but no readings arrive")).toBeUndefined(); // summary
    expect(isFlag("Certificates are rejected")).toBeUndefined();
    expect(isFlag("On Linux the relay logs")).toBeUndefined(); // <details open>
    expect(isFlag("Draft note, not for publication.")).toBeUndefined(); // hidden for another reason
    // (b) accordion
    expect(isFlag("A single reading may carry")).toBe(true); // hidden attribute
    expect(isFlag("Failed sends are retried")).toBe(true); // max-height:0
    expect(isFlag("The local queue holds")).toBeUndefined(); // aria-expanded=true
    for (const label of ["Payload size", "Retry schedule", "Queue length"]) expect(isFlag(label), label).toBeUndefined(); // the controls
    // (c) tabs
    expect(isFlag("Variables are read once")).toBe(true);
    expect(isFlag("The file is searched in")).toBe(true);
    expect(isFlag("fernwick-relay --proxy")).toBeUndefined(); // active tab
    for (const label of ["Command line", "Environment", "Config file"]) expect(isFlag(label), label).toBeUndefined();
    expect(c.snapshot.nodes.find((n) => n.tag === "code" && n.own_text.includes("FERNWICK_PROXY"))?.flags.disclosure).toBe(true);
    // (d) until-found
    expect(isFlag("Versions before 2.4")).toBe(true);
    expect(isFlag("Versions before 2.1")).toBe(true);
    // negatives: hidden modal (+ details inside it), off-screen ad (+ details inside it), popup menu, stale popup
    for (const frag of ["Tell us what was missing", "What do we do with it?", "Feedback is read by", "Sponsored: Lantern Cloud", "Why this ad?", "Shown because the page", "Overview", "You are reading an older copy"]) {
      expect(isFlag(frag), frag).toBeUndefined();
    }
    // visible content
    for (const frag of ["The relay forwards sensor readings", "Where are the logs", "Fernwick Docs are published"]) expect(isFlag(frag), frag).toBeUndefined();
    const n = nodes.filter((x) => x.flags.disclosure === true).length;
    expect(n).toBeGreaterThanOrEqual(20);
    console.log(`[disclosure] docs-3: ${n} of ${nodes.length} nodes flagged`);
  });
});

describe("no effect on FeatureSchema v0", () => {
  it("the 12 corpus fixtures carry no flag (their snapshot ids are the ones produced before the flag existed)", async () => {
    for (const name of fixtureNames().filter((n) => n !== "docs-3")) {
      const c = await captureFixture(launched, name);
      expect(c.snapshot.nodes.filter((n) => n.flags.disclosure !== undefined), name).toEqual([]);
    }
  });
  it("vectorize ignores the flag: docs-3 gives byte-identical features with and without it", async () => {
    const c = await captureFixture(launched, "docs-3");
    const stripped = { ...c.snapshot, nodes: c.snapshot.nodes.map((n) => ({ ...n, flags: { in_shadow: n.flags.in_shadow, iframe_depth: n.flags.iframe_depth } })) };
    const a = JSON.stringify(vectorize(c.snapshot, featureSchemaV0).x);
    const b = JSON.stringify(vectorize(stripped, featureSchemaV0).x);
    expect(a).toBe(b);
    expect(featureSchemaV0.schema_id).toBe("sha256:22b5e302ae50bb12c8e2ca4e50f96066791e5c1cb30f1a4c4eb9b265deb179e2");
  });
});
