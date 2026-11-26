// QA tool, the local review pages: one static file each, no external resource, and the page actually works (run in jsdom:
// buttons, shortcuts, the reserve candidates that appear only after a rejection, the export the import reads back).
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { CANDIDATE_KINDS, KIND_QUOTA } from "../src/stages/qa/prompts.js";
import { candidateReviewHtml, embedJson, judgeReviewHtml, type ReviewData } from "../src/stages/qa/review-html.js";
import { parseReviewExport } from "../src/stages/qa/taskset.js";
import { CANDIDATES_FORMAT, type CandidatesDoc } from "../src/stages/qa/types.js";
import { HASH } from "./qa-fixtures.js";

const D2 = "# Title\n\nThe widget costs fifty dollars today. </script><b>x</b> & more text that follows the quote.\n\nPosted by Jane.";
const data = (): ReviewData => ({
  candidates_id: HASH("e"),
  kind_quota: { ...KIND_QUOTA },
  pages: [
    {
      group_id: "shop.example#000000000001",
      stratum: "product",
      d2: D2,
      candidates: CANDIDATE_KINDS.map((kind, i) => ({ rank: i + 1, kind, question: `Q${i + 1} </script>?`, answer: `A${i + 1}`, answer_variants: ["v"], quote: "The widget costs fifty dollars today.", offset: D2.indexOf("The widget"), advisory: i === 0 ? ["answer_not_in_quote"] : [] })),
    },
  ],
});

const open = (html: string): JSDOM => new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
const cards = (d: JSDOM): HTMLElement[] => [...d.window.document.querySelectorAll<HTMLElement>(".card")];
const exportOf = (d: JSDOM): { decisions: Array<Record<string, unknown>>; reviewer: string; candidates_id: string } => (d.window as unknown as { __gpExport(): never }).__gpExport();
const click = (d: JSDOM, el: Element): void => void el.dispatchEvent(new d.window.MouseEvent("click", { bubbles: true }));
const key = (d: JSDOM, k: string): void => void d.window.document.dispatchEvent(new d.window.KeyboardEvent("keydown", { key: k, bubbles: true }));
const button = (card: HTMLElement, label: string): HTMLButtonElement => [...card.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;

describe("the candidate review page", () => {
  const html = candidateReviewHtml(data());

  it("is one static file with no external resource", () => {
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
    expect(html).not.toMatch(/@import|url\(/);
    expect(html).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
    expect((html.match(/<\/script>/g) ?? []).length).toBe(2); // the embedded data and the code; page text cannot close them
  });

  it("embedded data cannot break out of its script element", () => {
    expect(embedJson({ a: "</script><!--&" })).not.toMatch(/[<>&]/);
    expect(JSON.parse(embedJson({ a: "x y</script>" }))).toEqual({ a: "x y</script>" });
  });

  it("shows the quota's candidates, the question, the answer, the highlighted evidence and the advisory notes", () => {
    const d = open(html);
    const c = cards(d);
    expect(c).toHaveLength(5); // 2 main + 2 category + 1 support: the reserves are hidden
    expect(c[0]!.textContent).toContain("Q1 </script>?");
    expect(c[0]!.textContent).toContain("Answer: A1");
    expect(c[0]!.textContent).toContain("answer_not_in_quote");
    expect(c[0]!.querySelector("mark")?.textContent).toBe("The widget costs fifty dollars today.");
    expect(d.window.document.getElementById("stats")?.textContent).toBe("0 accepted, 0 rejected, 5 pending of 5 shown");
  });

  it("three yes/no questions per candidate: all yes accepts, any no rejects, and the export says exactly that", () => {
    const d = open(html);
    const first = (): HTMLElement => cards(d)[0]!;
    const rows = (): HTMLElement[] => [...first().querySelectorAll<HTMLElement>(".row")].slice(0, 3);
    for (let i = 0; i < 3; i++) click(d, rows()[i]!.querySelectorAll("button")[0]!); // Yes, Yes, Yes
    expect(exportOf(d).decisions.find((x) => x["rank"] === 1)).toMatchObject({ group_id: "shop.example#000000000001", rank: 1, answers_from_page: true, unique: true, correct: true });
    expect(first().classList.contains("acc")).toBe(true);
    click(d, rows()[1]!.querySelectorAll("button")[1]!); // unique? No
    expect(first().classList.contains("rej")).toBe(true);
    expect(exportOf(d).decisions.find((x) => x["rank"] === 1)).toMatchObject({ answers_from_page: true, unique: false, correct: true });
    click(d, rows()[1]!.querySelectorAll("button")[1]!); // the same button again clears the answer
    expect(exportOf(d).decisions.find((x) => x["rank"] === 1)).toMatchObject({ unique: null });
    expect(first().classList.contains("acc") || first().classList.contains("rej")).toBe(false);
  });

  it("a rejection reveals the next candidate of that kind (a reserve) and the shortcuts a / r work and move on", () => {
    const d = open(html);
    expect(cards(d)).toHaveLength(5);
    click(d, button(cards(d)[1]!, "Reject (r)")); // the first category candidate (rank 2)
    expect(cards(d)).toHaveLength(6); // category rank 6 appears
    expect(cards(d).some((e) => e.textContent?.includes("Q6"))).toBe(true);
    // keyboard: k goes back to the first card, a accepts it and jumps to the next pending one, r rejects that one
    key(d, "k");
    key(d, "a");
    expect(exportOf(d).decisions.find((x) => x["rank"] === 1)).toMatchObject({ answers_from_page: true, unique: true, correct: true });
    key(d, "r");
    const rejected = exportOf(d).decisions.filter((x) => x["unique"] === false || x["answers_from_page"] === false).map((x) => x["rank"]);
    expect(rejected.sort()).toEqual([2, 3]);
    expect(d.window.document.getElementById("stats")?.textContent).toBe("1 accepted, 2 rejected, 3 pending of 6 shown");
  });

  it("what the page exports is what the import reads back (the same candidates id, the reviewer, the decisions)", () => {
    const d = open(html);
    (d.window.document.getElementById("reviewer") as HTMLInputElement).value = "ana";
    d.window.document.getElementById("reviewer")!.dispatchEvent(new d.window.Event("input"));
    click(d, button(cards(d)[0]!, "Accept (a)"));
    const cdoc = { format: CANDIDATES_FORMAT, candidates_id: HASH("e"), pages: [{ group_id: "shop.example#000000000001", candidates: CANDIDATE_KINDS.map((_, i) => ({ rank: i + 1 })) }] } as unknown as CandidatesDoc;
    const parsed = parseReviewExport(exportOf(d), cdoc);
    expect(parsed.reviewer).toBe("ana");
    expect(parsed.decisions).toEqual([{ group_id: "shop.example#000000000001", rank: 1, answers_from_page: true, unique: true, correct: true }]);
  });

  it("remembers the work in the browser's storage (when there is one)", () => {
    const d = open(html);
    click(d, button(cards(d)[0]!, "Accept (a)"));
    expect(d.window.localStorage.getItem(`gp-qa-review:${HASH("e")}`)).toContain('"state"');
  });
});

describe("the judge sample page", () => {
  const items = [
    { task_id: "t1", arm: "full_page", question: "Q1?", answer: "A1", answer_variants: [], response: "the response" },
    { task_id: "t2", arm: "pruned_model", question: "Q2?", answer: "A2", answer_variants: ["v"], response: "" },
  ];
  const html = judgeReviewHtml({ sample_id: HASH("5"), items });

  it("is self-contained and does not show the judge's verdict (it is not even in the data)", () => {
    expect(html).not.toMatch(/<script[^>]*\ssrc=|<link\b|https?:\/\//i);
    expect(html).not.toMatch(/judge_verdict|verdict":/);
  });

  it("grades with buttons and keys and exports the verdicts with the sample id", () => {
    const d = open(html);
    expect(d.window.document.querySelectorAll(".card")).toHaveLength(2);
    expect(d.window.document.body.textContent).toContain("(empty response)");
    key(d, "c");
    key(d, "i");
    const ex = (d.window as unknown as { __gpExport(): { sample_id: string; verdicts: unknown[] } }).__gpExport();
    expect(ex.sample_id).toBe(HASH("5"));
    expect(ex.verdicts).toEqual([{ task_id: "t1", arm: "full_page", verdict: "correct" }, { task_id: "t2", arm: "pruned_model", verdict: "incorrect" }]);
  });
});
