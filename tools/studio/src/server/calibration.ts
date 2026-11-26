import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertTruthRules, gpIdx, importTruth, type TruthImport, type TruthRule } from "@gran-prix/labels";
import {
  CALIBRATION_GROUPS,
  allFixtures,
  fixturesOf,
  judge,
  scoreGroup,
  summarize,
  type CalGroup,
  type CalibrationSummary,
  type GroupResult,
  type UnitJudged,
  type UnitTruth,
} from "../core/calibration.js";
import { effectiveLabels } from "../core/labels.js";
import { isLabelClass, GUIDE_VERSION, type LabelClass } from "../core/types.js";
import type { HumanStore } from "./human-store.js";
import type { PageCache, PageData } from "./pages.js";
import { readHtml, type PageRef } from "./snapshot-set.js";
import { StoreError } from "./human-store.js";

/**
 * The calibration exercise on the server (guide section 7). The expected label of a unit is what the fixture's
 * `truth.json` (guide revisions R1-R3 included) gives its element; it exists only on the server and leaves it in one
 * place: the result of a group the owner has FINISHED. Until then no response carries an expected label, a rule or a
 * selector's outcome (the targets are listed with their selector and a neutral description only).
 *
 * Finished results are frozen in `<task store>/calibration.json`: relabeling after the result was shown does not change it.
 */

export const CALIBRATION_TASK = "calibration";
const RESULT_FORMAT = "gran-prix.studio-calibration";

/** The fixture a stored page is, from the URL it was collected under (`.../fixtures/pages/<name>.html`). */
export function fixtureNameOf(url: string): string | null {
  const m = /(?:^|[/\\])fixtures[/\\]pages[/\\]([a-z0-9-]+)\.html(?:[?#].*)?$/i.exec(url);
  return m ? (m[1] as string).toLowerCase() : null;
}

export interface TargetUnits {
  fixture: string;
  selector: string;
  matched: number;
  /** Units of U at or below the matched elements, in document order. */
  units: number[];
}

interface Truth {
  imp: TruthImport;
}

export interface GroupView {
  n: number;
  title: string;
  fixtures: string[];
  /** Page hex per fixture (`null`: the fixture is not in the data dir). */
  pages: Array<{ fixture: string; hex: string | null }>;
  targets: Array<{ fixture: string; selector: string; what: string }>;
  available: boolean;
  /** Units to label in the group (all targets) and how many of them have a label now. */
  units_total: number;
  units_labeled: number;
  finished: boolean;
  /** Present only once the group is finished. */
  result?: GroupResult;
}

interface StoredResults {
  format: typeof RESULT_FORMAT;
  format_version: "1.0.0";
  annotator: string;
  guide_version: string;
  groups: Record<string, GroupResult>;
}

export class Calibration {
  private readonly truths = new Map<string, Promise<Truth>>();

  constructor(
    private readonly store: HumanStore,
    private readonly cache: PageCache,
    private readonly fixturesDir: string,
    private readonly refs: () => PageRef[],
  ) {}

  /** Fixture name to the page that holds it in the data dir. */
  fixturePages(): Map<string, PageRef> {
    const out = new Map<string, PageRef>();
    for (const ref of this.refs()) {
      const name = fixtureNameOf(ref.entry.url);
      if (name !== null && !out.has(name)) out.set(name, ref);
    }
    return out;
  }

  /** Pages of the exercise present in the data dir (what the task opens). */
  pages(): PageRef[] {
    const have = this.fixturePages();
    return allFixtures().flatMap((f) => (have.has(f) ? [have.get(f) as PageRef] : []));
  }

  /** True when every fixture of the 12 groups is in the data dir. */
  complete(): boolean {
    const have = this.fixturePages();
    return allFixtures().every((f) => have.has(f));
  }

  private truth(name: string, ref: PageRef): Promise<Truth> {
    const key = `${name}:${ref.hex}`;
    let p = this.truths.get(key);
    if (!p) {
      p = Promise.resolve().then(() => {
        const file = join(this.fixturesDir, `${name}.truth.json`);
        if (!existsSync(file)) throw new StoreError(500, `calibration: ${file} not found (use --fixtures-dir)`);
        const rules = (JSON.parse(readFileSync(file, "utf8")) as { rules: unknown }).rules;
        assertTruthRules(rules);
        return { imp: importTruth(readHtml(ref), rules as TruthRule[]) };
      });
      this.truths.set(key, p);
    }
    return p;
  }

  /** Units (of U) of each target of a group, from the page's own tree: no truth involved (it only reads the fixture's selectors). */
  async targetUnits(g: CalGroup): Promise<TargetUnits[]> {
    const have = this.fixturePages();
    const out: TargetUnits[] = [];
    for (const tg of g.targets) {
      const ref = have.get(tg.fixture);
      if (!ref) {
        out.push({ fixture: tg.fixture, selector: tg.selector, matched: 0, units: [] });
        continue;
      }
      const { imp } = await this.truth(tg.fixture, ref);
      const page = this.cache.load(ref);
      const idxs = [...imp.page.doc.querySelectorAll(tg.selector)].map((el) => gpIdx(el)).filter((i): i is number => i !== null);
      const units = new Set<number>();
      for (const i of idxs) for (const u of page.model.units) if (u >= i && u < i + (page.model.size[i] as number)) units.add(u);
      out.push({ fixture: tg.fixture, selector: tg.selector, matched: idxs.length, units: [...units].sort((a, b) => a - b) });
    }
    return out;
  }

  private readResults(): StoredResults {
    const p = join(this.store.dir, "calibration.json");
    const empty: StoredResults = { format: RESULT_FORMAT, format_version: "1.0.0", annotator: this.store.annotator, guide_version: GUIDE_VERSION, groups: {} };
    if (!existsSync(p)) return empty;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as StoredResults;
      return raw.format === RESULT_FORMAT && raw.groups && typeof raw.groups === "object" ? raw : empty;
    } catch {
      return empty;
    }
  }

  private writeResults(r: StoredResults): void {
    const p = join(this.store.dir, "calibration.json");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(`${p}.tmp-${process.pid}`, `${JSON.stringify(r)}\n`);
    renameSync(`${p}.tmp-${process.pid}`, p);
  }

  results(): Array<GroupResult | null> {
    const stored = this.readResults().groups;
    return CALIBRATION_GROUPS.map((g) => stored[String(g.n)] ?? null);
  }

  summary(): CalibrationSummary {
    return summarize(this.results());
  }

  /** The 12 groups with their progress; the expected labels appear only inside the `result` of a finished group. */
  async groups(): Promise<{ groups: GroupView[]; summary: CalibrationSummary }> {
    const have = this.fixturePages();
    const stored = this.readResults().groups;
    const views: GroupView[] = [];
    for (const g of CALIBRATION_GROUPS) {
      const fx = fixturesOf(g);
      const available = fx.every((f) => have.has(f));
      let total = 0;
      let labeled = 0;
      if (available) {
        const byFixture = new Map<string, Set<number>>();
        for (const tu of await this.targetUnits(g)) {
          const set = byFixture.get(tu.fixture) ?? new Set<number>();
          tu.units.forEach((u) => set.add(u));
          byFixture.set(tu.fixture, set);
        }
        for (const [fixture, units] of byFixture) {
          const ref = have.get(fixture) as PageRef;
          const page = this.cache.load(ref);
          const eff = effectiveLabels(page.model, this.store.load(ref.hex, page.nodes.length));
          for (const u of units) {
            total++;
            if (eff.cls[u] !== null && eff.cls[u] !== undefined) labeled++;
          }
        }
      }
      const result = stored[String(g.n)];
      views.push({
        n: g.n,
        title: g.title,
        fixtures: fx,
        pages: fx.map((f) => ({ fixture: f, hex: have.get(f)?.hex ?? null })),
        targets: g.targets.map(({ fixture, selector, what }) => ({ fixture, selector, what })),
        available,
        units_total: total,
        units_labeled: labeled,
        finished: result !== undefined,
        ...(result ? { result } : {}),
      });
    }
    return { groups: views, summary: this.summary() };
  }

  /**
   * Finishes a group: every unit of its targets must have a label. The result (expected x given) is computed now, frozen on
   * disk and returned. Finishing a finished group returns the frozen result.
   */
  async finish(n: number, now: Date): Promise<GroupResult> {
    const g = CALIBRATION_GROUPS.find((x) => x.n === n);
    if (!g) throw new StoreError(404, `no calibration group ${n}`);
    const stored = this.readResults();
    const done = stored.groups[String(n)];
    if (done) return done;
    const have = this.fixturePages();
    const missing = fixturesOf(g).filter((f) => !have.has(f));
    if (missing.length > 0) throw new StoreError(409, `fixture page(s) not collected in this data dir: ${missing.join(", ")}`);

    const judged: UnitJudged[] = [];
    let unlabeled = 0;
    let outside = 0;
    for (const tu of await this.targetUnits(g)) {
      const ref = have.get(tu.fixture) as PageRef;
      if (tu.matched === 0) throw new StoreError(500, `calibration definition: selector ${tu.selector} matches nothing in ${tu.fixture}`);
      if (tu.units.length === 0) {
        outside++;
        continue;
      }
      const { imp } = await this.truth(tu.fixture, ref);
      const page: PageData = this.cache.load(ref);
      const eff = effectiveLabels(page.model, this.store.load(ref.hex, page.nodes.length));
      for (const u of tu.units) {
        const given = eff.cls[u];
        if (given === null || given === undefined) {
          unlabeled++;
          continue;
        }
        const expected = imp.labels.get(u);
        if (!isLabelClass(expected)) throw new StoreError(500, `calibration: the truth of ${tu.fixture} gives no label to n${u} (${tu.selector})`);
        const unit: UnitTruth = { fixture: tu.fixture, selector: tu.selector, unit_id: u, tag: page.nodes[u]?.t ?? "", text: (page.nodes[u]?.x ?? "").slice(0, 120), expected: expected as LabelClass };
        judged.push(judge(unit, given));
      }
    }
    if (unlabeled > 0) throw new StoreError(409, `${unlabeled} unit(s) of the group have no label yet`);
    const result = scoreGroup(n, judged, outside, now.toISOString());
    stored.groups[String(n)] = result;
    this.writeResults(stored);
    return result;
  }
}
