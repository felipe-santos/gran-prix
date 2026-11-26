// Quota bookkeeping of the walk, rebuilt from the append-only walked.jsonl (so a killed run resumes exactly).
import { CATEGORIES, MAX_NON_EN_SHARE, MAX_PER_DOMAIN, MAX_PER_DOMAIN_CATEGORY } from "./config.mjs";

/**
 * The records that count: a record is superseded by a LATER record of the same (category, url), written by `revisit`
 * (a candidate re-evaluated after a collector defect was fixed). walked.jsonl stays append-only; every output uses this view.
 */
export function effectiveRecords(records) {
  const last = new Map();
  records.forEach((r, i) => last.set(`${r.category}|${r.url}`, i));
  return records.filter((r, i) => last.get(`${r.category}|${r.url}`) === i);
}

/** Reason prefix of the records written by `apply-review`: `owner-review:<motivo>`. */
export const OWNER_REVIEW_PREFIX = "owner-review:";

export const targetOf = (category) => CATEGORIES.find((c) => c.name === category)?.n ?? 0;
/** Per-category cap of pages in pt/es: floor(30% of the target) = 9 for n=30, 7 for n=25. */
export const nonEnCap = (category) => Math.floor(MAX_NON_EN_SHARE * targetOf(category));

export class WalkState {
  constructor() {
    this.walked = new Set(); // `${walk_category}|${url}`
    this.acceptedUrls = new Set();
    this.acceptedByCategory = new Map(); // category -> number
    this.nonEnByCategory = new Map();
    this.domainCategory = new Map(); // `${domain}|${category}` -> number
    this.domainTotal = new Map();
    this.blocked = new Set(); // URLs the owner excluded in review: never candidates again, in any category or phase
    this.cursors = new Map(); // `${walk_category}|${phase}` -> highest order_hash walked there (where a resumed walk continues)
  }

  static key(walkCategory, url) {
    return `${walkCategory}|${url}`;
  }

  /** Rebuilds the state from walked records (in file order). */
  static replay(records) {
    const s = new WalkState();
    for (const r of records) {
      s.walked.add(WalkState.key(r.walk_category, r.url));
      s.noteCursor(r);
      if (typeof r.reason === "string" && r.reason.startsWith(OWNER_REVIEW_PREFIX)) s.blocked.add(r.url);
      if (r.outcome === "accepted") s.accept(r);
    }
    return s;
  }

  noteCursor(r) {
    const k = `${r.walk_category}|${r.phase}`;
    if (r.order_hash && r.order_hash > (this.cursors.get(k) ?? "")) this.cursors.set(k, r.order_hash);
  }

  /** The highest `order_hash` walked in this (category, phase) (`""` if none): a resumed walk continues after it. */
  cursor(category, phase) {
    return this.cursors.get(`${category}|${phase}`) ?? "";
  }

  count(category) {
    return this.acceptedByCategory.get(category) ?? 0;
  }

  /** `null` when the (domain, category) slot is free, else the reason. Applies "1 per (domain, category) and 2 per domain". */
  quotaReason(category, domain) {
    if ((this.domainCategory.get(`${domain}|${category}`) ?? 0) >= MAX_PER_DOMAIN_CATEGORY) return "domain-category-quota";
    if ((this.domainTotal.get(domain) ?? 0) >= MAX_PER_DOMAIN) return "domain-quota";
    return null;
  }

  /** `null` or "language-cap": a pt/es page when the category already holds its share. */
  languageReason(category, lang) {
    return lang !== "en" && (this.nonEnByCategory.get(category) ?? 0) >= nonEnCap(category) ? "language-cap" : null;
  }

  accept(r) {
    const c = r.category;
    this.acceptedUrls.add(r.url);
    this.acceptedByCategory.set(c, this.count(c) + 1);
    if (r.detail?.lang !== "en") this.nonEnByCategory.set(c, (this.nonEnByCategory.get(c) ?? 0) + 1);
    for (const d of new Set([r.domain, r.detail?.group_key].filter(Boolean))) {
      this.domainCategory.set(`${d}|${c}`, (this.domainCategory.get(`${d}|${c}`) ?? 0) + 1);
      this.domainTotal.set(d, (this.domainTotal.get(d) ?? 0) + 1);
    }
  }
}
