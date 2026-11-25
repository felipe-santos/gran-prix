// pageFlags: `captcha` marks a challenge page (title phrase, or the pattern in a SHORT rendered text), not a page that
// merely talks about CAPTCHAs. Synthetic pages only.
import { describe, expect, it } from "vitest";
import { CAPTCHA_TEXT_MAX_CHARS, pageFlags, type FlagNode } from "../src/stages/collect/flags.js";

const node = (parent: number, text: string): FlagNode => ({ parent, own_text: text, text_len: text.length, style: { display: "block", visibility: "visible" } });
/** A page: a root plus one text node per paragraph, padded so the page does not also read as `tiny-dom`. */
function pageOf(title: string, paragraphs: string[]): { title: string; http_status: number; nodes: FlagNode[] } {
  const filler = Array.from({ length: 80 }, () => node(0, ""));
  return { title, http_status: 200, nodes: [node(-1, ""), ...paragraphs.map((p) => node(0, p)), ...filler] };
}
const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(" ");

describe("captcha: challenge pages", () => {
  it("Cloudflare interstitial: title 'Just a moment...'", () => {
    const p = pageOf("Just a moment...", ["Enable JavaScript and cookies to continue"]);
    expect(pageFlags(p)).toContain("captcha");
  });
  it("title 'Attention Required! | Cloudflare' and 'Robot Check'", () => {
    expect(pageFlags(pageOf("Attention Required! | Cloudflare", ["Please complete the security check to access the site."]))).toContain("captcha");
    expect(pageFlags(pageOf("Robot Check", ["Enter the characters you see below."]))).toContain("captcha");
  });
  it("'Checking your browser' in a short text with an unrelated title", () => {
    expect(pageFlags(pageOf("example.com", ["Checking your browser before accessing example.com. This process is automatic."]))).toContain("captcha");
  });
  it("Google 'unusual traffic' page", () => {
    const text =
      "Our systems have detected unusual traffic from your computer network. This page checks to see if it's really you sending the requests, and not a robot. Why did this happen? IP address: 203.0.113.9 Time: 2026-01-01T00:00:00Z URL: https://www.google.com/search?q=x";
    expect(text.length).toBeLessThan(CAPTCHA_TEXT_MAX_CHARS);
    expect(pageFlags(pageOf("https://www.google.com/search?q=x", [text]))).toContain("captcha");
  });
  it("hCaptcha page", () => {
    expect(pageFlags(pageOf("Access check", ["Please verify you are human to continue.", "Protected by hCaptcha. Privacy - Terms"]))).toContain("captcha");
  });
});

describe("captcha: pages that only mention CAPTCHAs", () => {
  it("a long documentation page that talks about CAPTCHA in prose", () => {
    const p = pageOf("Authentication guide | Docs", [
      `Enable CAPTCHA protection to stop bots from signing up. ${words(300)}`,
      `The captcha token is verified server side. If the user fails the captcha the request is rejected. ${words(200)}`,
    ]);
    expect(pageFlags(p)).not.toContain("captcha");
  });
  it("a documentation page whose title mentions CAPTCHA (not an interstitial phrase)", () => {
    expect(pageFlags(pageOf("reCAPTCHA settings | Docs", [words(400)]))).not.toContain("captcha");
    expect(pageFlags(pageOf("CAPTCHA best practices", [words(400)]))).not.toContain("captcha");
  });
  it("a shop or contact form with 'protected by reCAPTCHA'", () => {
    const p = pageOf("Contact us", [words(250), "This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.", words(100)]);
    expect(pageFlags(p)).not.toContain("captcha");
  });
  it("the limit separates the cases: the same sentence is a challenge only in a short page", () => {
    const sentence = "Please verify you are human.";
    expect(pageFlags(pageOf("Welcome", [sentence]))).toContain("captcha");
    expect(pageFlags(pageOf("Welcome", [sentence, words(CAPTCHA_TEXT_MAX_CHARS)]))).not.toContain("captcha");
  });
});
