import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importTruth, type TruthRule } from "@gran-prix/labels";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  CALIBRATION_CRITERION,
  CALIBRATION_GROUPS,
  allFixtures,
  isKeep,
  judge,
  scoreGroup,
  summarize,
  type GroupResult,
  type UnitTruth,
} from "../src/core/calibration.js";
import type { LabelClass } from "../src/core/types.js";
import type { RunningStudio } from "../src/server/app.js";
import { Calibration, fixtureNameOf } from "../src/server/calibration.js";
import { HumanStore } from "../src/server/human-store.js";
import { PageCache } from "../src/server/pages.js";
import { listPages, readHtml, type PageRef } from "../src/server/snapshot-set.js";
import { cleanupTmp } from "./helpers.js";
import { FIXTURES_DIR, startOn, type Api, type Harness } from "./harness.js";

afterAll(cleanupTmp);
const running: RunningStudio[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

/** Guide section 7, column "Esperado", one entry per target of the definition (`outside`: not in U, nothing to label). */
const EXPECTED: Record<string, LabelClass | "outside"> = {
  "article-1 h1": "main",
  "article-1 .dek": "main",
  "article-1 .byline": "support",
  "article-1 figcaption": "support",
  "article-1 .tags": "support",
  "article-1 .share": "noise",
  "article-1 .related": "noise",
  "article-1 #subscribe-modal": "outside",
  "article-1 .comments .comment": "support",
  "article-1 .comments button": "noise",
  "article-2 .toc": "support",
  "article-2 newsletter-box": "noise",
  "article-2 .stealth": "outside",
  "product-1 .price": "main",
  "product-1 .stock": "support",
  "product-1 .variants": "support",
  "product-1 .add": "noise",
  "product-1 .wish": "noise",
  "product-1 .reviews": "support",
  "product-1 .related-products": "noise",
  "product-1 .trust li:nth-child(-n+2)": "support",
  "product-1 .trust li:nth-child(3)": "noise",
  "product-1 .promo-bar": "noise",
  "product-2 product-specs": "main",
  "product-2 .delivery": "support",
  "product-2 .options": "support",
  "product-2 .video-note": "noise",
  "product-2 .chat": "noise",
  "docs-1 article.doc > pre": "main",
  "docs-1 .breadcrumbs": "support",
  "docs-1 .toc-right": "support",
  "docs-1 .side": "noise",
  "docs-1 .feedback": "noise",
  "docs-1 .pager": "noise",
  "docs-2 .deprecated": "support",
  "docs-2 .see-also": "noise",
  "forum-1 .post-text": "main",
  "forum-1 .sig": "noise",
  "forum-1 .author-col": "support",
  "forum-1 .post-actions": "noise",
  "forum-1 .forum-side": "noise",
  "forum-2 .votes div": "support",
  "forum-2 .votes button": "noise",
  "forum-2 .post-user": "support",
  "forum-2 .comments": "support",
  "forum-2 .your-answer": "noise",
  "landing-1 .eyebrow": "support",
  "landing-1 #pricing": "support",
  "landing-1 #stories": "support",
  "landing-1 .feature": "main",
  "landing-1 .logo-strip": "noise",
  "landing-1 .cta-band": "noise",
  "landing-1 .fine": "noise",
  "landing-1 #beta-popup": "outside",
  "landing-2 #faq": "support",
  "landing-2 .stores": "noise",
};

describe("calibration scoring (guide section 7)", () => {
  const truth = (expected: LabelClass): UnitTruth => ({ fixture: "f", selector: "s", unit_id: 1, tag: "p", text: "t", expected });

  it("keep x drop and 3 classes are scored apart", () => {
    expect(isKeep("main") && isKeep("support") && !isKeep("noise")).toBe(true);
    expect(judge(truth("support"), "main")).toMatchObject({ binary_ok: true, three_ok: false }); // both kept: a 3-class error only
    expect(judge(truth("support"), "noise")).toMatchObject({ binary_ok: false, three_ok: false });
    expect(judge(truth("noise"), "support")).toMatchObject({ binary_ok: false, three_ok: false });
    expect(judge(truth("noise"), "noise")).toMatchObject({ binary_ok: true, three_ok: true });
  });

  it("a group is right only when every one of its units is right", () => {
    const ok = judge(truth("main"), "main");
    const soft = judge(truth("support"), "main");
    const hard = judge(truth("noise"), "main");
    expect(scoreGroup(1, [ok, ok], 0, "t")).toMatchObject({ binary_ok: true, three_ok: true, n_units: 2, errors: [] });
    const r = scoreGroup(2, [ok, soft, hard], 1, "t");
    expect(r).toMatchObject({ binary_ok: false, three_ok: false, binary_errors: 1, three_errors: 2, n_outside_targets: 1 });
    expect(r.errors).toEqual([soft, hard]);
    expect(scoreGroup(3, [ok, soft], 0, "t")).toMatchObject({ binary_ok: true, three_ok: false, binary_errors: 0, three_errors: 1 });
  });

  it("the criterion is >= 11/12 in keep x drop and >= 10/12 in 3 classes, decided only when all 12 groups are finished", () => {
    expect(CALIBRATION_CRITERION).toEqual({ groups: 12, binary: 11, three_class: 10 });
    const g = (b: boolean, t: boolean): Pick<GroupResult, "binary_ok" | "three_ok"> => ({ binary_ok: b, three_ok: t });
    const build = (binaryWrong: number, threeWrong: number): Array<Pick<GroupResult, "binary_ok" | "three_ok">> => Array.from({ length: 12 }, (_, i) => g(i >= binaryWrong, i >= threeWrong));
    expect(summarize(build(0, 0))).toMatchObject({ finished: 12, binary_correct: 12, three_correct: 12, passed: true });
    expect(summarize(build(1, 2))).toMatchObject({ binary_correct: 11, three_correct: 10, passed: true });
    expect(summarize(build(2, 2)).passed).toBe(false); // 10/12 in keep x drop
    expect(summarize(build(1, 3)).passed).toBe(false); // 9/12 in 3 classes
    expect(summarize([...build(0, 0).slice(0, 11), null])).toMatchObject({ finished: 11, passed: null });
    expect(summarize(Array(12).fill(null))).toMatchObject({ finished: 0, binary_correct: 0, passed: null });
  });
});

describe("the definition of the 12 groups", () => {
  it("has the 12 groups of the table, each fixture with a truth.json, and no class name in anything the owner reads", () => {
    expect(CALIBRATION_GROUPS.map((g) => g.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(allFixtures().sort()).toEqual(["article-1", "article-2", "docs-1", "docs-2", "forum-1", "forum-2", "landing-1", "landing-2", "product-1", "product-2"]);
    for (const f of allFixtures()) expect(existsSync(join(FIXTURES_DIR, `${f}.truth.json`)), f).toBe(true);
    const shown = JSON.stringify(CALIBRATION_GROUPS.map((g) => [g.title, g.targets.map((t) => t.what)]));
    expect(shown).not.toMatch(/principal|suporte|ru[ií]do|main|support|noise|keep|drop|fora de U|conte[uú]do|concreto|gen[eé]rico/i);
    expect(CALIBRATION_GROUPS.flatMap((g) => g.targets.map((t) => `${t.fixture} ${t.selector}`)).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("fixtureNameOf recognizes the collected fixture pages by URL", () => {
    expect(fixtureNameOf("fixtures/pages/article-1.html")).toBe("article-1");
    expect(fixtureNameOf("file:///repo/fixtures/pages/forum-2.html")).toBe("forum-2");
    expect(fixtureNameOf("/repo/fixtures/pages/docs-3.html#x")).toBe("docs-3");
    expect(fixtureNameOf("https://example.com/articles/fixtures-pages.html")).toBeNull();
    expect(fixtureNameOf("https://example.com/x/fixtures/pages/a.html.bak")).toBeNull();
  });
});

const refsByFixture = (dir: string): Map<string, PageRef> => new Map(listPages(dir).map((r) => [fixtureNameOf(r.entry.url) as string, r]));

/** The truth of a fixture, computed here from the same truth.json, independently of the server code. */
function fixtureTruth(ref: PageRef, name: string): ReturnType<typeof importTruth> {
  const rules = (JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.truth.json`), "utf8")) as { rules: TruthRule[] }).rules;
  return importTruth(readHtml(ref), rules);
}

describe("the expected labels are the fixtures' (guide table of section 7, with revisions R1-R3)", () => {
  it("every target of every group resolves to elements, and its units carry exactly the class of the table", async () => {
    const dir = (await startOn("calibrationDataDir", {}, running)).dataDir;
    const refs = refsByFixture(dir);
    const cal = new Calibration(new HumanStore(dir, "ana", "blind", "calibration"), new PageCache(), FIXTURES_DIR, () => listPages(dir));
    expect(cal.complete()).toBe(true);
    const truths = new Map([...refs].map(([name, ref]) => [name, fixtureTruth(ref, name)]));
    let units = 0;
    for (const g of CALIBRATION_GROUPS) {
      for (const tu of await cal.targetUnits(g)) {
        const key = `${tu.fixture} ${tu.selector}`;
        expect(tu.matched, `${key} matches an element`).toBeGreaterThan(0);
        const want = EXPECTED[key];
        const t = truths.get(tu.fixture) as ReturnType<typeof importTruth>;
        if (want === "outside") {
          expect(tu.units, `${key} is outside U`).toEqual([]);
          continue;
        }
        expect(tu.units.length, `${key} has units in U`).toBeGreaterThan(0);
        expect([...new Set(tu.units.map((u) => t.labels.get(u)))], key).toEqual([want]);
        units += tu.units.length;
      }
    }
    expect(units).toBeGreaterThan(100);
    // the fixtures' truth is complete (guide lint): every text element of every fixture has a label
    for (const [name, t] of truths) expect(t.uncovered, name).toEqual([]);
  });
});

/** Labels, in the test's own accumulator, the units of a group: the expected class unless `wrong` says otherwise. */
class Labeler {
  private readonly explicit = new Map<string, Record<string, LabelClass>>();
  constructor(
    private readonly h: Harness,
    private readonly cal: Calibration,
  ) {}

  async label(n: number, wrong: Record<string, LabelClass> = {}): Promise<void> {
    const refs = refsByFixture(this.h.dataDir);
    const g = CALIBRATION_GROUPS.find((x) => x.n === n)!;
    for (const tu of await this.cal.targetUnits(g)) {
      const ref = refs.get(tu.fixture) as PageRef;
      const t = fixtureTruth(ref, tu.fixture);
      const acc = this.explicit.get(ref.hex) ?? {};
      for (const u of tu.units) acc[u] = wrong[`${tu.fixture} ${tu.selector}`] ?? (t.labels.get(u) as LabelClass);
      this.explicit.set(ref.hex, acc);
      const r = await this.h.api("PUT", `/api/tasks/calibration/pages/${ref.hex}/state`, { labels: { explicit: acc, flags: {} } });
      expect(r.status, r.text).toBe(200);
    }
  }
}

const finish = (api: Api, n: number) => api("POST", `/api/tasks/calibration/groups/${n}/finish`, {});

async function startCalibration(): Promise<{ h: Harness; labeler: Labeler }> {
  const h = await startOn("calibrationDataDir", {}, running);
  const cal = new Calibration(new HumanStore(h.dataDir, "ana", "blind", "calibration"), new PageCache(), FIXTURES_DIR, () => listPages(h.dataDir));
  return { h, labeler: new Labeler(h, cal) };
}

describe("calibration over HTTP: blind, no expected before the group is finished", () => {
  it("lists the 12 groups with progress and no expected label, and the task as blind and not exportable", async () => {
    const { h } = await startCalibration();
    const r = await h.api("GET", "/api/tasks/calibration/groups");
    expect(r.status).toBe(200);
    expect(r.json["groups"]).toHaveLength(12);
    for (const g of r.json["groups"]) expect(g).toMatchObject({ available: true, finished: false, units_labeled: 0 });
    expect(r.json["groups"][0].units_total).toBeGreaterThan(0);
    expect(r.json["summary"]).toMatchObject({ total: 12, finished: 0, passed: null, binary_needed: 11, three_needed: 10 });
    expect(r.text).not.toMatch(/expected|errors|"result"|truth|rules/i);
    const task = ((await h.api("GET", "/api/tasks")).json["tasks"] as Array<Record<string, any>>).find((t) => t["id"] === "calibration")!;
    expect(task).toMatchObject({ mode: "blind", total: 12, done: 0, available: true, next: { group: 1 } });
    // the pages of the exercise never carry a draft or the truth, and the labels are not exported
    const hex = r.json["groups"][0].pages[0].hex as string;
    const page = await h.api("GET", `/api/tasks/calibration/pages/${hex}`);
    expect(page.json["state"]).toMatchObject({ mode: "blind", explicit: {} });
    expect(page.json).not.toHaveProperty("draft");
    expect(page.text).not.toMatch(/"expected"|"truth"|"rules"/);
    expect((await h.api("POST", `/api/tasks/calibration/pages/${hex}/export`, {})).status).toBe(409);
    expect((await h.api("POST", "/api/tasks/calibration/export", {})).status).toBe(409);
  });

  it("refuses to finish a group with unlabeled units and reveals nothing", async () => {
    const { h, labeler } = await startCalibration();
    const none = await finish(h.api, 1);
    expect(none.status).toBe(409);
    expect(none.json["error"]).toMatch(/no label yet/);
    expect(none.text).not.toMatch(/expected|main|support|noise/);
    await labeler.label(1);
    // group 2 shares the page but is untouched: still unfinished, still hidden
    expect((await finish(h.api, 2)).status).toBe(409);
    expect((await finish(h.api, 13)).status).toBe(404);
  });

  it("scores a finished group against the fixture truth, lists the errors and freezes the result", async () => {
    const { h, labeler } = await startCalibration();
    await labeler.label(1);
    const ok = await finish(h.api, 1);
    expect(ok.status).toBe(200);
    expect(ok.json["result"]).toMatchObject({ n: 1, binary_ok: true, three_ok: true, errors: [], n_outside_targets: 0 });
    expect(ok.json["result"].n_units).toBeGreaterThan(1);
    expect(ok.json["summary"]).toMatchObject({ finished: 1, binary_correct: 1, three_correct: 1, passed: null });

    // group 2: .share (noise) kept as support = a keep x drop error; .byline (support) called main = a 3-class error only
    await labeler.label(2, { "article-1 .share": "support", "article-1 .byline": "main" });
    const bad = (await finish(h.api, 2)).json["result"] as GroupResult;
    expect(bad).toMatchObject({ n: 2, binary_ok: false, three_ok: false, n_outside_targets: 1 });
    expect(bad.errors.length).toBe(bad.three_errors);
    expect(bad.binary_errors).toBeGreaterThan(0);
    expect(bad.three_errors).toBeGreaterThan(bad.binary_errors);
    const shares = bad.errors.filter((e) => e.selector === ".share");
    const bylines = bad.errors.filter((e) => e.selector === ".byline");
    expect(shares.length).toBe(bad.binary_errors);
    expect(shares.every((e) => e.expected === "noise" && e.given === "support" && !e.binary_ok)).toBe(true);
    expect(bylines.length).toBeGreaterThan(0);
    expect(bylines.every((e) => e.expected === "support" && e.given === "main" && e.binary_ok && !e.three_ok)).toBe(true);
    expect(bad.errors.every((e) => e.fixture === "article-1" && e.text !== "" && e.tag !== "")).toBe(true);

    // the expected labels appear only in the groups that are finished
    const view = (await h.api("GET", "/api/tasks/calibration/groups")).json;
    expect(view["groups"].map((g: any) => [g.n, g.finished, "result" in g])).toEqual(Array.from({ length: 12 }, (_, i) => [i + 1, i < 2, i < 2]));
    expect(view["summary"]).toMatchObject({ finished: 2, binary_correct: 1, three_correct: 1 });
    const unfinished = JSON.stringify(view["groups"].slice(2));
    expect(unfinished).not.toMatch(/expected|errors|"given"/);

    // relabeling afterwards does not change what was frozen; finishing again returns it
    await labeler.label(2);
    const again = await finish(h.api, 2);
    expect(again.json["result"]).toEqual(bad);
    const file = join(h.dataDir, "human-labels", "ana", "tasks", "calibration", "calibration.json");
    expect(JSON.parse(readFileSync(file, "utf8")).groups["2"]).toEqual(bad);
  });

  it("finishing the 12 groups decides the criterion: all right passes", async () => {
    const { h, labeler } = await startCalibration();
    for (let n = 1; n <= 12; n++) {
      await labeler.label(n);
      const r = await finish(h.api, n);
      expect(r.status, `group ${n}: ${r.text}`).toBe(200);
      expect(r.json["result"], `group ${n}`).toMatchObject({ binary_ok: true, three_ok: true });
    }
    const view = (await h.api("GET", "/api/tasks/calibration/groups")).json;
    expect(view["summary"]).toEqual({ total: 12, finished: 12, binary_correct: 12, three_correct: 12, binary_needed: 11, three_needed: 10, passed: true });
    expect(view["groups"].every((g: any) => g.units_labeled === g.units_total)).toBe(true);
    const task = ((await h.api("GET", "/api/tasks")).json["tasks"] as Array<Record<string, any>>).find((t) => t["id"] === "calibration")!;
    expect(task).toMatchObject({ done: 12, next: null });
    expect(task["calibration"]).toMatchObject({ passed: true });
    // outside-U targets are correct by construction: groups 2, 4 and 12
    expect(view["groups"].filter((g: any) => g.result.n_outside_targets > 0).map((g: any) => g.n)).toEqual([2, 4, 12]);
  });

  it("with only some fixtures collected, the groups that need the others are unavailable and cannot be finished", async () => {
    const h = await startOn("corpusDataDir", {}, running); // article-1 and product-2 only
    const view = (await h.api("GET", "/api/tasks/calibration/groups")).json;
    expect(view["groups"].map((g: any) => g.available)).toEqual([true, true, true, false, false, false, true, false, false, false, false, false]);
    expect(view["groups"][3].pages).toEqual([{ fixture: "article-2", hex: null }]);
    const r = await finish(h.api, 4);
    expect(r.status).toBe(409);
    expect(r.json["error"]).toMatch(/article-2/);
    expect(((await h.api("GET", "/api/tasks")).json["tasks"] as Array<Record<string, any>>).find((t) => t["id"] === "calibration")).toMatchObject({ available: false });
  });
});
