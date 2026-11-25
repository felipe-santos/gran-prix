import { contractId } from "../identity/contract-ids.js";
import type { LabelAgreement } from "../label-agreement.js";
import type { QaTaskSet } from "../qa-task-set.js";
import { gateIssues } from "./inv-eval.js";
import { Issues } from "./result.js";

const EPS = 1e-9;

/** Invariants of LabelAgreement (C0): kappa and its parts are recomputed from the confusion matrix. */
export function labelAgreementInvariants(a: LabelAgreement): Issues {
  const out = new Issues("label-agreement");
  const keys = new Set(Object.keys(a.labelers));
  const seenPairs = new Set<string>();
  a.pairs.forEach((p, i) => {
    const at = `pairs[${i}]`;
    out.check(keys.has(p.a), `${at}.a`, `"${p.a}" is not a key of labelers`);
    out.check(keys.has(p.b), `${at}.b`, `"${p.b}" is not a key of labelers`);
    out.check(p.a !== p.b, `${at}.b`, "a labeler cannot be compared with itself");
    const pk = `${[p.a, p.b].sort().join("|")}|${p.stratum}`;
    out.check(!seenPairs.has(pk), at, `duplicate pair ${p.a} / ${p.b} for stratum "${p.stratum}"`);
    seenPairs.add(pk);
    if (p.stratum !== "overall") out.check(p.stratum in a.population.by_stratum, `${at}.stratum`, `stratum "${p.stratum}" is not "overall" nor in population.by_stratum`);
    p.results.forEach((r, j) => kappaIssues(r, `${at}.results[${j}]`, out));
  });
  const sumGroups = Object.values(a.population.by_stratum).reduce((s, v) => s + v.n_groups, 0);
  const sumUnits = Object.values(a.population.by_stratum).reduce((s, v) => s + v.n_units, 0);
  out.check(sumGroups === a.population.n_groups, "population.n_groups", `by_stratum groups sum to ${sumGroups}, n_groups is ${a.population.n_groups}`);
  out.check(sumUnits === a.population.n_units, "population.n_units", `by_stratum units sum to ${sumUnits}, n_units is ${a.population.n_units}`);
  if (a.retest) out.check(keys.has(a.retest.labeler), "retest.labeler", `"${a.retest.labeler}" is not a key of labelers`);
  const gateIds = (a.gates ?? []).map((g) => g.id);
  (a.gates ?? []).forEach((g, j) => {
    out.check(gateIds.indexOf(g.id) === j, `gates[${j}].id`, `duplicate gate id "${g.id}"`);
    gateIssues(g, `gates[${j}]`, out);
  });
  out.idCheck(a.agreement_id === contractId("label-agreement", a), "agreement_id", "does not match the hash of the document (excluding agreement_id and provenance)");
  return out;
}

function kappaIssues(r: LabelAgreement["pairs"][number]["results"][number], at: string, out: Issues): void {
  const k = r.classes.length;
  if (r.ci95) out.check(r.ci95[0] <= r.ci95[1], `${at}.ci95`, "ci95 must be [lo, hi] with lo <= hi");
  out.check(new Set(r.classes).size === k, `${at}.classes`, "classes must be unique");
  if (r.space === "binary") out.check(k === 2, `${at}.classes`, "a binary space has exactly 2 classes");
  const square = r.confusion.length === k && r.confusion.every((row) => row.length === k);
  out.check(square, `${at}.confusion`, `confusion must be ${k} x ${k}`);
  if (!square) return;
  const n = r.confusion.reduce((s, row) => s + row.reduce((x, y) => x + y, 0), 0);
  out.check(n === r.n, `${at}.n`, `n is ${r.n} but confusion sums to ${n}`);
  if (n === 0) return;
  const rows = r.confusion.map((row) => row.reduce((x, y) => x + y, 0));
  const cols = r.classes.map((_, c) => r.confusion.reduce((s, row) => s + (row[c] as number), 0));
  const po = r.confusion.reduce((s, row, i) => s + (row[i] as number), 0) / n;
  const pe = rows.reduce((s, ri, i) => s + ri * (cols[i] as number), 0) / (n * n);
  out.check(Math.abs(po - r.observed_agreement) < EPS, `${at}.observed_agreement`, `recomputed ${po} from confusion, got ${r.observed_agreement}`);
  out.check(Math.abs(pe - r.expected_agreement) < EPS, `${at}.expected_agreement`, `recomputed ${pe} from confusion, got ${r.expected_agreement}`);
  if (1 - pe > EPS) {
    const kappa = (po - pe) / (1 - pe);
    out.check(Math.abs(kappa - r.kappa) < EPS, `${at}.kappa`, `recomputed ${kappa} from confusion, got ${r.kappa}`);
  }
}

/** Invariants of QaTaskSet (C10). */
export function qaTaskSetInvariants(s: QaTaskSet): Issues {
  const out = new Issues("qa-task-set");
  const pages = new Map(s.pages.map((p) => [p.group_id, p]));
  out.check(pages.size === s.pages.length, "pages", "duplicate group_id in pages");
  const ids = new Set<string>();
  s.tasks.forEach((t, i) => {
    const at = `tasks[${i}]`;
    out.check(!ids.has(t.id), `${at}.id`, `duplicate task id "${t.id}"`);
    ids.add(t.id);
    const page = pages.get(t.group_id);
    out.check(page !== undefined, `${at}.group_id`, `"${t.group_id}" is not in pages`);
    if (page) out.check(page.stratum === t.stratum, `${at}.stratum`, `task stratum "${t.stratum}" differs from its page's "${page.stratum}"`);
    const words = t.answer.trim().split(/\s+/).length;
    out.check(words <= 20, `${at}.answer`, `answer has ${words} words, the limit is 20`);
    t.evidence.unit_ids.forEach((u, k) => {
      if (k > 0) out.check(u > (t.evidence.unit_ids[k - 1] as number), `${at}.evidence.unit_ids[${k}]`, "unit_ids must be strictly increasing");
    });
    out.check(t.evidence.quote.trim().length > 0, `${at}.evidence.quote`, "quote must not be blank");
  });
  const r = s.review;
  out.check(r.n_accepted === s.tasks.length, "review.n_accepted", `${r.n_accepted} accepted declared, but tasks has ${s.tasks.length}`);
  out.check(r.n_accepted + r.n_rejected === r.n_candidates, "review.n_candidates", `accepted (${r.n_accepted}) + rejected (${r.n_rejected}) must equal candidates (${r.n_candidates})`);
  out.check(Math.abs(r.rejection_rate - r.n_rejected / r.n_candidates) < EPS, "review.rejection_rate", `must equal n_rejected / n_candidates (${r.n_rejected / r.n_candidates})`);
  out.idCheck(s.task_set_id === contractId("qa-task-set", s), "task_set_id", "does not match the hash of the document (excluding task_set_id and provenance)");
  return out;
}
