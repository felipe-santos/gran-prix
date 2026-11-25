import { describe, expect, it } from "vitest";
import { causeOf } from "../src/attempt-diff.mjs";

const x = (dest, rec) => ({ dest, rec });
describe("attempt-diff causes", () => {
  it("names the defect that moved a page", () => {
    expect(causeOf(x("excluded:language:tl", { reason: "language:tl" }), x("accepted:docs", {}), true)).toMatch(/^idioma/);
    expect(causeOf(x("excluded:flag:captcha", { reason: "flag:captcha" }), x("accepted:landing", {}), true)).toMatch(/^captcha/);
    expect(causeOf(x("excluded:adult-content", { reason: "adult-content" }), x("accepted:docs", {}), true)).toMatch(/^adulto/);
    expect(causeOf(x("excluded:capture", { reason: "capture", detail: { message: "el.children is not iterable" } }), x("accepted:product", {}), true)).toMatch(/clobbering/);
    expect(causeOf(x("excluded:capture", { reason: "capture", detail: { message: "x" } }), x("accepted:product", {}), true)).toMatch(/transient/);
  });
  it("quadro, cascade and site state", () => {
    expect(causeOf(undefined, x("accepted:spa", {}), false)).toMatch(/^quadro/);
    expect(causeOf(x("accepted:article", { reason: "ok" }), undefined, true)).toMatch(/filled earlier/);
    expect(causeOf(undefined, x("accepted:article", {}), true)).toMatch(/never walked/);
    expect(causeOf(x("excluded:http-status-403", { reason: "http-status-403" }), x("accepted:article", {}), true)).toMatch(/^cascade or site state/);
  });
});
