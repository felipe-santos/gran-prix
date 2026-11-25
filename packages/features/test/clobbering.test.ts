// DOM clobbering: a <form> whose controls are named like Element/Node properties and methods, and <img name=...>
// elements named like `document` properties, must not break the probe or change what it reports.
// The pages are inline (not fixtures): the ids of the 13 fixtures are asserted elsewhere to be unchanged.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, probeLoadedPage, type Launched, type RawProbe } from "../src/index.js";

let launched: Launched;
beforeAll(async () => { launched = await launch(); });
afterAll(async () => { await launched?.browser.close(); });

/** Names that shadow what the probe reads on a form element (HTMLFormElement has [LegacyOverrideBuiltIns]). */
const FORM_NAMES = [
  "children", "childNodes", "tagName", "shadowRoot", "getAttribute", "setAttribute", "hasAttribute", "parentElement",
  "attributes", "id", "nodeType", "nodeValue", "textContent", "getBoundingClientRect", "getClientRects", "closest",
  "matches", "checkVisibility", "getRootNode", "firstChild", "className", "style", "type", "open", "hidden",
];
/** Names that shadow `document` properties (Document has [LegacyOverrideBuiltIns]) when carried by img/form/embed/object. */
const DOC_NAMES = ["documentElement", "title", "readyState", "querySelector", "querySelectorAll", "getElementById", "body", "head", "cloneNode"];

const page = (nameOf: (n: string) => string): string => `<!doctype html><html lang="en"><head><title>Clobber test</title>
<meta property="og:type" content="product"><script type="application/ld+json">{"@type":"Product"}</script></head><body>
<form id="f1" action="/buy"><label>Qty</label>${FORM_NAMES.map((n) => `<input name="${nameOf(n)}" value="x">`).join("")}<button type="submit">Buy</button></form>
<form id="f2"><button aria-expanded="false" aria-controls="panel">More</button><div id="panel" hidden><p>Hidden details text</p></div></form>
${DOC_NAMES.map((n, i) => (i % 3 === 0 ? `<img name="${nameOf(n)}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">` : i % 3 === 1 ? `<form name="${nameOf(n)}"><input name="a"></form>` : `<embed name="${nameOf(n)}">`)).join("\n")}
<details><summary>Q</summary><p id="ans">collapsed answer</p></details>
<main><h1>Title</h1><p>Some body text for the page.</p></main></body></html>`;

async function probeHtml(html: string): Promise<RawProbe> {
  const p = await launched.context.newPage();
  try {
    await p.route("https://fixture.test/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: html }));
    await p.goto("https://fixture.test/p", { waitUntil: "load" });
    return (await probeLoadedPage(p, { quietMs: 100 })).raw;
  } finally {
    await p.close();
  }
}

/** Everything the probe reports except the `name` attribute, the only thing the two pages differ in. */
const shape = (raw: RawProbe) => ({
  page: { ...raw.page, url: "", final_url: "" },
  nodes: raw.nodes.map(({ attrs, ...n }) => ({ ...n, attrs: { ...attrs, name: undefined } })),
  text_units: raw.text_units,
});

describe("probe on a page with clobbering names", () => {
  it("is a real clobbering page: the plain DOM reads are broken", async () => {
    const p = await launched.context.newPage();
    try {
      await p.setContent(page((n) => n));
      const broken = await p.evaluate(() => {
        const f = Document.prototype.getElementById.call(document, "f1") as unknown as Record<string, unknown>;
        return { children: f["children"] instanceof HTMLCollection, tagName: typeof f["tagName"], docEl: document.documentElement instanceof HTMLHtmlElement };
      });
      expect(broken.children).toBe(false);
      expect(broken.tagName).not.toBe("string");
      expect(broken.docEl).toBe(false);
    } finally {
      await p.close();
    }
  });

  it("terminates and reports the same nodes, ids and text as the same page with innocuous names", async () => {
    const clobbered = await probeHtml(page((n) => n));
    const plain = await probeHtml(page((n) => `x-${n}`));
    expect(clobbered.nodes.length).toBeGreaterThan(40);
    expect(clobbered.settle.late_unstamped).toBe(0);
    expect(shape(clobbered)).toEqual(shape(plain));
    clobbered.nodes.forEach((n, i) => expect(n.idx).toBe(i));
  });

  it("keeps the page signals and the disclosure flags (details, aria-controls) on the clobbered page", async () => {
    const raw = await probeHtml(page((n) => n));
    expect(raw.page.title).toBe("Clobber test");
    expect(raw.page.og_type).toBe("product");
    expect(raw.page.jsonld_types).toEqual(["Product"]);
    expect(raw.page.lang).toBe("en");
    const flagged = raw.nodes.filter((n) => n.flags.disclosure === true).map((n) => n.attrs.id ?? n.tag);
    expect(flagged).toEqual(["panel", "p", "ans"]);
    const form = raw.nodes.find((n) => n.attrs.id === "f1");
    expect(form?.child_elems).toBe(FORM_NAMES.length + 2); // controls + label + button
  });
});
