// Selections of the labeling plan of the DOM experiment (protocol experimento-dom-v0.md, section 5.1), mechanical and by hash.
//
//   order(purpose, url) = sha256("gp-dom-v0|20261125|" + purpose + "|" + url), lowercase hex, ASCENDING (ties: url).
//
// `20261125` is the pre-registered seed (section 2.3 / 13); `gp-dom-v0|20261125|` is the order prefix of the corpus walk
// (tools/corpus/src/config.mjs ORDER_PREFIX) with the purpose added, so each selection is an independent, reproducible
// order over the same frozen corpus: nobody picks a page. Pure and deterministic; no clock, no randomness.
import { createHash } from "node:crypto";

export const ORDER_PREFIX = "gp-dom-v0|20261125|";
export const PURPOSES = ["prompt-dev", "audit", "retest", "train-sample", "test-review"];

/** The hash that orders `url` for `purpose`. */
export const orderHash = (purpose, url) => createHash("sha256").update(`${ORDER_PREFIX}${purpose}|${url}`, "utf8").digest("hex");

/** Pages (with `.url`) in ascending order of the purpose hash. */
export function sortedFor(purpose, pages) {
  return pages
    .map((p) => ({ p, h: orderHash(purpose, p.url) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.p.url < b.p.url ? -1 : a.p.url > b.p.url ? 1 : 0))
    .map((x) => x.p);
}

export const DEFAULT_SIZES = { prompt_dev: 10, audit_per_category: 5, retest: 10, train_sample_fraction: 0.1 };

/**
 * `pages`: [{ snapshot_id, url, category, split: "train"|"val"|"test" }].
 *
 *  - prompt-dev (5.1.2): the first 10 TRAIN pages.
 *  - audit (5.1.3): the first 5 of EACH CATEGORY of the TEST split (a category with fewer takes all it has: the SPA has 3).
 *  - retest (5.4): the first 10 of the audit pages (order of `retest`).
 *  - train-sample (5.1.7): ceil(10% of the train pages) of the train pages that are NOT prompt-dev (INTERPRETATION: the
 *    pages of prompt-dev already have a human label from scratch, so they carry no information about the label noise
 *    of the LLM-labeled pages the sample is meant to estimate).
 *  - test-review (5.1.6): the test pages that are not in the audit.
 *
 * Returns each selection as an ordered array of pages (the order of its own purpose hash).
 */
export function selectPages(pages, sizes = DEFAULT_SIZES) {
  const train = pages.filter((p) => p.split === "train");
  const test = pages.filter((p) => p.split === "test");
  const promptDev = sortedFor("prompt-dev", train).slice(0, sizes.prompt_dev);
  const promptDevIds = new Set(promptDev.map((p) => p.snapshot_id));

  const categories = [...new Set(test.map((p) => p.category))].sort();
  const auditSet = new Set();
  const auditByCategory = {};
  for (const c of categories) {
    const taken = sortedFor("audit", test.filter((p) => p.category === c)).slice(0, sizes.audit_per_category);
    auditByCategory[c] = taken.length;
    for (const p of taken) auditSet.add(p.snapshot_id);
  }
  const audit = sortedFor("audit", test.filter((p) => auditSet.has(p.snapshot_id)));
  const retest = sortedFor("retest", audit).slice(0, sizes.retest);
  const nTrainSample = Math.ceil(sizes.train_sample_fraction * train.length);
  const trainSample = sortedFor(
    "train-sample",
    train.filter((p) => !promptDevIds.has(p.snapshot_id)),
  ).slice(0, nTrainSample);
  const testReview = sortedFor(
    "test-review",
    test.filter((p) => !auditSet.has(p.snapshot_id)),
  );
  return { "prompt-dev": promptDev, audit, retest, "train-sample": trainSample, "test-review": testReview, audit_by_category: auditByCategory, n_train_sample: nTrainSample };
}

/** Counts per category and split of a list of pages (for the report). */
export function countsBy(pages, key) {
  const out = {};
  for (const p of pages) out[p[key]] = (out[p[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}
