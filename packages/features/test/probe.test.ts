// The in-page probe on small synthetic pages (served through page.route, so they have an http origin).
import { validate } from "@gran-prix/contracts";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleSource, featureSchemaV0, findChromium, launch, probeLoadedPage, vectorize, buildPageSnapshot, type Launched, type RawProbe } from "../src/index.js";

let launched: Launched;
beforeAll(async () => { launched = await launch(); });
afterAll(async () => { await launched?.browser.close(); });

async function probeHtml(html: string, opts: Parameters<typeof probeLoadedPage>[1] = {}): Promise<RawProbe> {
  const page = await launched.context.newPage();
  try {
    await page.route("https://fixture.test/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: html }));
    await page.goto("https://fixture.test/page?utm_source=x#frag", { waitUntil: "load" });
    return (await probeLoadedPage(page, opts)).raw;
  } finally {
    await page.close();
  }
}

const MIXED = `<!doctype html><html lang="pt"><head><title>T</title>
<meta property="og:type" content="Article">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"NewsArticle"},{"@type":["Product","Thing"]}]}</script>
</head><body>
<div id="host"><span>light</span></div>
<p id="p1">Hello <a href="/x" class="lnk">link</a> tail</p>
<input type="email" name="e" aria-label="mail"><button>Go</button>
<script>const sr = document.getElementById('host').attachShadow({mode:'open'}); sr.innerHTML = '<b id="in-shadow">shadow text</b>';</script>
</body></html>`;

describe("id scheme: composed pre-order", () => {
  it("visits element, then open-shadow children, then light children; text units are <owner>#t<child index>", async () => {
    const raw = await probeHtml(MIXED);
    const tags = raw.nodes.map((n) => n.tag);
    expect(tags).toEqual(["html", "head", "title", "meta", "script", "body", "div", "b", "span", "p", "a", "input", "button", "script"]);
    raw.nodes.forEach((n, i) => expect(n.idx).toBe(i));
    const b = raw.nodes[7]!;
    expect(b.attrs.id).toBe("in-shadow");
    expect(b.parent).toBe(6); // the shadow host
    expect(b.flags.in_shadow).toBe(true);
    expect(raw.nodes[8]!.flags.in_shadow).toBe(false); // light child of the host
    expect(raw.nodes[8]!.parent).toBe(6);
    expect(raw.text_units.map((t) => t.id)).toEqual(["n2#t0", "n7#t0", "n8#t0", "n9#t0", "n10#t0", "n9#t2", "n12#t0"]);
    expect(raw.text_units.find((t) => t.id === "n9#t2")!.t).toBe(" tail");
  });

  it("stamps data-gp-id on the live DOM with the same ids (shadow content included)", async () => {
    const page = await launched.context.newPage();
    try {
      await page.route("https://fixture.test/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: MIXED }));
      await page.goto("https://fixture.test/", { waitUntil: "load" });
      await probeLoadedPage(page);
      const ids = await page.evaluate(() => ({
        shadow: document.getElementById("host")!.shadowRoot!.querySelector("b")!.getAttribute("data-gp-id"),
        p: document.getElementById("p1")!.getAttribute("data-gp-id"),
        count: Array.from(document.querySelectorAll("[data-gp-id]")).length + 1, // + the shadow <b>
      }));
      expect(ids).toEqual({ shadow: "n7", p: "n9", count: 14 });
    } finally {
      await page.close();
    }
  });
});

describe("captured fields", () => {
  it("records href, id, role-less attrs, form-control type, text lengths, page signals", async () => {
    const raw = await probeHtml(MIXED);
    expect(raw.page).toMatchObject({ final_url: "https://fixture.test/page?utm_source=x#frag", title: "T", lang: "pt", og_type: "article", jsonld_types: ["NewsArticle", "Product", "Thing"] });
    const a = raw.nodes[10]!;
    expect(a.attrs).toEqual({ class: "lnk", href: "/x" });
    expect(raw.nodes[11]!.attrs).toEqual({ type: "email", name: "e", "aria-label": "mail" });
    expect(raw.nodes[12]!.attrs.type).toBe("submit"); // implicit default of <button>
    const p = raw.nodes[9]!;
    expect(p.own_text).toBe("Hello tail");
    expect(p.own_text_len).toBe(10);
    expect(p.text_len).toBe(14);
    expect(p.link_text_len).toBe(4);
    expect(p.child_elems).toBe(1);
    expect(raw.nodes[0]!.text_len).toBeGreaterThanOrEqual(raw.nodes[5]!.text_len);
    expect(raw.nodes[4]!.own_text).toBe(""); // <script> text is code, not content
    expect(raw.nodes[2]!.rect).toBeNull(); // <title>: display:none, no box
    expect(raw.nodes[9]!.rect).not.toBeNull();
    expect(raw.nodes[9]!.style).toMatchObject({ display: "block", visibility: "visible", opacity: 1, position: "static" });
  });

  it("truncates own_text but measures own_text_len first; a truncated text has an unknown ending", async () => {
    const long = ("word ".repeat(700)).trim() + ".";
    const raw = await probeHtml(`<html><body><p>${long}</p></body></html>`);
    const p = raw.nodes.find((n) => n.tag === "p")!;
    expect(p.own_text_len).toBe(long.length);
    expect(p.own_text.length).toBe(1000);
    const nf = vectorize({ snapshot_id: `sha256:${"b".repeat(64)}`, page: raw.page, doc: raw.doc, nodes: raw.nodes }, featureSchemaV0);
    const col = featureSchemaV0.features.findIndex((f) => f.name === "ends_with_punct");
    expect(nf.x[nf.unit_ids.indexOf(p.idx)]![col]).toBe(0.5);
  });

  it("makes lone surrogates well-formed so the content id can be hashed", async () => {
    const raw = await probeHtml(`<html><body><p id="x">a</p><script>document.getElementById('x').append(String.fromCharCode(0xD800) + ' tail', String.fromCharCode(0xDC00));</script></body></html>`);
    const p = raw.nodes.find((n) => n.attrs.id === "x")!;
    expect(p.own_text).toBe("a� tail�");
    const snap = buildPageSnapshot(raw, {
      category: "test", html: { path: "r.html", sha256: `sha256:${"c".repeat(64)}`, bytes: 1 },
      capture: { collector_version: "t", browser: { name: "chromium", version: "x" }, user_agent: "ua", http_status: 200, captured_at: "2026-01-01T00:00:00Z" },
    });
    expect(validate("page-snapshot", snap).issues).toEqual([]);
    expect(snap.page.url_key).toBe("https://fixture.test/page"); // tracking param and fragment removed
    expect(snap.page.group_key).toBe("fixture.test");
  });
});

describe("settle", () => {
  it("observes open shadow roots attached AFTER insertion (no attachShadow patch) and waits for their mutations", async () => {
    const html = `<html><body><div id="h">x</div><script>
      const sr = document.getElementById('h').attachShadow({mode:'open'});   // attached right away, no mutation record
      setTimeout(() => { sr.innerHTML = '<i id="late">late shadow</i>'; }, 900);
    </script></body></html>`;
    const raw = await probeHtml(html);
    expect(raw.settle.reason).toBe("quiet");
    expect(raw.settle.shadow_roots).toBe(1);
    expect(raw.nodes.some((n) => n.attrs.id === "late")).toBe(true);
    expect(raw.settle.late_unstamped).toBe(0);
  });

  it("reports the elements that appear after stamping as late_unstamped", async () => {
    const page = await launched.context.newPage();
    try {
      await page.route("https://fixture.test/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<html><body><p>x</p></body></html>" }));
      await page.goto("https://fixture.test/", { waitUntil: "load" });
      const raw = await page.evaluate(() => {
        setTimeout(() => document.body.append(document.createElement("i")), 60);
        return window.__gpFeatures!.probe({ settle: false, lateCheckMs: 250 });
      });
      expect(raw.settle.reason).toBe("skipped");
      expect(raw.settle.late_unstamped).toBe(1);
    } finally {
      await page.close();
    }
  });

  it("hits the hard cap on a page that never stops mutating", async () => {
    const html = `<html><body><p id="t">0</p><script>let n = 0; setInterval(() => { document.getElementById('t').textContent = String(++n); }, 100);</script></body></html>`;
    const raw = await probeHtml(html, { maxMs: 1500 });
    expect(raw.settle.reason).toBe("max");
    expect(raw.settle.waited_ms).toBeGreaterThanOrEqual(1500);
    expect(raw.settle.waited_ms).toBeLessThan(2500);
  });
});

// G5 performance: the probe no longer asks the DOM for the rect of an element in a display:none subtree or with display:contents,
// and asks getBoundingClientRect before getClientRects. `rect === null` must stay exactly "getClientRects() is empty".
describe("rect is null exactly when the element has no box", () => {
  const BOXES = `<!doctype html><html><head><title>t</title><style>#none *{display:block} .empty{display:inline} .atorigin{position:absolute;left:0;top:0;width:0;height:0}</style></head><body style="margin:0">
<div id="none" style="display:none"><p>in a hidden subtree <b>deep</b></p><section><div></div></section></div>
<div id="contents" style="display:contents"><span>child of display:contents</span></div>
<span class="empty"></span><i class="atorigin"></i><div style="height:0"></div><div style="display:none"></div>
<details><summary>s</summary><p>closed details child</p></details>
<div hidden><span>hidden attr</span></div><div id="host"></div>
<script>const r = document.getElementById('host').attachShadow({mode:'open'}); r.innerHTML = '<div style="display:none"><i>x</i></div><u>u</u>';</script>
<table><tr><td>cell</td></tr></table><select><option>o</option></select><textarea></textarea><svg width="0" height="0"><g><circle r="1"/></g></svg></body></html>`;

  it("agrees, for every element, with getClientRects().length === 0", async () => {
    const page = await launched.context.newPage();
    try {
      await page.route("https://fixture.test/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: BOXES }));
      await page.goto("https://fixture.test/", { waitUntil: "load" });
      const raw = (await probeLoadedPage(page)).raw;
      const live = await page.evaluate(() => {
        const out: Record<string, boolean> = {};
        const walk = (root: ParentNode): void => {
          for (const el of Array.from(root.querySelectorAll("*"))) {
            const id = el.getAttribute("data-gp-id");
            if (id) out[id] = el.getClientRects().length === 0;
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        };
        walk(document);
        return out;
      });
      expect(Object.keys(live).length).toBe(raw.nodes.length);
      let nulls = 0;
      for (const n of raw.nodes) {
        expect(n.rect === null, `n${n.idx} <${n.tag}>`).toBe(live[`n${n.idx}`]);
        if (n.rect === null) nulls++;
      }
      expect(nulls).toBeGreaterThan(8); // the page has boxless elements of every kind
      expect(raw.nodes.some((n) => n.rect !== null && n.rect.w === 0 && n.rect.h === 0)).toBe(true); // and zero-size ones that do have a box
    } finally {
      await page.close();
    }
  });
});

describe("injection paths", () => {
  it("works when the bundle is injected late with evaluate (extension-like) and is idempotent", async () => {
    const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ["--no-sandbox"] });
    try {
      const page = await (await browser.newContext()).newPage(); // NO init script
      await page.route("https://fixture.test/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: MIXED }));
      await page.goto("https://fixture.test/", { waitUntil: "load" });
      expect(await page.evaluate(() => typeof window.__gpFeatures)).toBe("undefined");
      const src = bundleSource();
      await page.evaluate(src);
      const same = await page.evaluate((s) => {
        const first = window.__gpFeatures;
        (0, eval)(s); // second injection must not replace the API nor reset tracking
        return first === window.__gpFeatures;
      }, src);
      expect(same).toBe(true);
      const raw = await probeLoadedPage(page).then((r) => r.raw);
      expect(raw.settle.tracked_from_start).toBe(false);
      expect(raw.nodes).toHaveLength(14);
    } finally {
      await browser.close();
    }
  });
});
