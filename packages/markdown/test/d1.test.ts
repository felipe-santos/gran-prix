import { describe, expect, it } from "vitest";
import { d1Html, stripGpAttributes } from "../src/index.js";

describe("D1: the stored html without data-gp-* attributes", () => {
  it("removes every data-gp-* attribute and nothing else, byte for byte", () => {
    const html = `<html data-gp-id="n0" lang="en"><body data-gp-id="n1" class="a  b"><p data-gp-id="n2" id='x' data-gp-extra="1" title="a > b">Hi &amp; bye</p><img data-gp-id="n3" src="/a.png"></body></html>`;
    expect(stripGpAttributes(html)).toBe(`<html lang="en"><body class="a  b"><p id='x' title="a > b">Hi &amp; bye</p><img src="/a.png"></body></html>`);
  });

  it("is the identity when there is nothing to remove", () => {
    const html = `<html><body><p class="x">t</p></body></html>`;
    expect(stripGpAttributes(html)).toBe(html);
  });

  it("does not touch text, comments, or raw-text elements that merely look like attributes", () => {
    const html = [
      `<html data-gp-id="n0"><body data-gp-id="n1">`,
      `<p data-gp-id="n2">the attribute data-gp-id="n9" in prose</p>`,
      `<!-- <p data-gp-id="n8"> -->`,
      `<style data-gp-id="n3">a[data-gp-id="n1"]{color:red} /* <b data-gp-id="n5"> */</style>`,
      `<script data-gp-id="n4"></script>`,
      `<textarea data-gp-id="n6">&lt;i data-gp-id="n7"&gt;</textarea>`,
      `</body></html>`,
    ].join("");
    const out = stripGpAttributes(html);
    expect(out).toBe(
      [
        `<html><body>`,
        `<p>the attribute data-gp-id="n9" in prose</p>`,
        `<!-- <p data-gp-id="n8"> -->`,
        `<style>a[data-gp-id="n1"]{color:red} /* <b data-gp-id="n5"> */</style>`,
        `<script></script>`,
        `<textarea>&lt;i data-gp-id="n7"&gt;</textarea>`,
        `</body></html>`,
      ].join(""),
    );
  });

  it("handles unquoted values, upper-case names, valueless attributes and self-closing tags", () => {
    expect(stripGpAttributes(`<input DATA-GP-ID=n4 disabled data-gp-x><br data-gp-id="n5"/><div hidden data-gp-id=n6 class=a>x</div>`)).toBe(
      `<input disabled><br/><div hidden class=a>x</div>`,
    );
  });

  it("drops the doctype: D1 is documentElement.outerHTML", () => {
    expect(d1Html(`<!DOCTYPE html><html data-gp-id="n0"><body data-gp-id="n1">x</body></html>`)).toBe(`<html><body>x</body></html>`);
    expect(d1Html(`<html data-gp-id="n0"><body>x</body></html>`)).toBe(`<html><body>x</body></html>`);
  });

  it("a very large document is linear (no regex backtracking): 20k elements in well under a second", () => {
    const html = `<html><body>${`<div data-gp-id="n1" class="c"><span data-gp-id="n2">t</span></div>`.repeat(20000)}</body></html>`;
    const t = Date.now();
    const out = stripGpAttributes(html);
    expect(out).not.toContain("data-gp-");
    expect(Date.now() - t).toBeLessThan(1500);
  });
});
