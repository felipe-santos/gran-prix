// The walk of §2.3.2 re-run as a REPLAY, so that the corpus after the owner's review is the one that would have come out if the
// review had existed during the walk: per category (table order), per phase, candidates in hash order, each evaluated by §2.2
// against the state of the replay, until the target. Only what depends on the state is re-decided:
//   * domain quotas (pre-load and final-domain), the pt/es cap and the SPA fallback pool (what the other categories accepted);
//   * a candidate that was only barred by one of those and is free now is fetched now (it was never captured), with the same
//     code, user agent and rules, and its record supersedes the old one;
//   * a candidate accepted before whose slot is now taken (by a reopened candidate earlier in the order) is superseded by an
//     exclusion record, without fetching.
// Everything else is reused as recorded (http, robots, language of the page, flags, chars, capture, type, SPA rule...).
// URLs excluded by the owner are never candidates. Candidates with no record are fetched, in order, until the target is met.
import { CATEGORIES } from "./config.mjs";
import { etld1 } from "./hash.mjs";
import { OWNER_REVIEW_PREFIX, WalkState, targetOf } from "./state.mjs";
import { phasesFor } from "./walk.mjs";

/** Exclusion reasons that depend on the state of the walk (what was accepted before the candidate). */
const STATE_DEPENDENT = /^(domain-category-quota|domain-quota|language-cap)(:final-domain)?$/;
export const isStateDependent = (reason) => STATE_DEPENDENT.test(String(reason));

const keyOf = (category, url) => `${category}|${url}`;

/**
 * @param {object} c a Collector (real or scripted): `state`, `prescreen`, `visit`, `record`
 * @param {object[]} frame frame.jsonl rows
 * @param {object[]} records the effective records (the owner's exclusions already included)
 * @param {{exportSha?: string}} [opts]
 * @returns {Promise<{events: object[]}>} events: {type: "new"|"reopened"|"displaced", category, url, ...}
 */
export async function replayWalk(c, frame, records, { exportSha } = {}) {
  const byKey = new Map(records.map((r) => [keyOf(r.category, r.url), r]));
  const state = new WalkState();
  for (const r of records) if (typeof r.reason === "string" && r.reason.startsWith(OWNER_REVIEW_PREFIX)) state.blocked.add(r.url);
  c.state = state;
  const events = [];
  const accepted = new Set();
  const settled = new Set(); // accepted records the replay confirmed or superseded

  /** Why the replay state refuses a candidate (quota before loading, final-domain quota, language cap), or null. */
  const refusal = (cat, domain, detail) => {
    const pre = state.quotaReason(cat, domain);
    if (pre) return pre;
    if (detail?.group_key !== undefined) {
      const fq = state.quotaReason(cat, detail.group_key);
      if (fq) return `${fq}:final-domain`;
      return state.languageReason(cat, detail.lang);
    }
    return null;
  };

  const fetchNow = async (cat, cand, old) => {
    const pre = state.quotaReason(cat, cand.domain) ? null : await c.prescreen(cand, cat === "spa");
    const rec = await c.visit({ ...cand, supersedes: old?.seq }, pre);
    console.error(`  replay #${rec.seq} ${cat} ${rec.outcome === "accepted" ? "ACCEPT" : "skip  "} ${rec.reason}  ${cand.url.slice(0, 110)}  [${state.count(cat)}/${targetOf(cat)}]${old ? `  (was ${old.reason} #${old.seq})` : ""}`);
    if (rec.outcome === "accepted") {
      accepted.add(keyOf(cat, cand.url));
      settled.add(keyOf(cat, cand.url));
      events.push({ type: old ? "reopened" : "new", category: cat, url: cand.url, phase: cand.phase, old_reason: old?.reason ?? null, old_seq: old?.seq ?? null, seq: rec.seq });
    }
  };

  const displace = (cat, cand, old, reason) => {
    const rec = c.record({ ...cand, phase: old.phase, supersedes: old.seq }, "excluded", reason, { detail: old.detail, screenshot: old.screenshot, replay: { kind: "displaced", export_sha256: exportSha } });
    settled.add(keyOf(cat, cand.url));
    events.push({ type: "displaced", category: cat, url: cand.url, reason, old_seq: old.seq, seq: rec.seq });
  };

  for (const { name: cat } of CATEGORIES) {
    const n = targetOf(cat);
    for (const ph of phasesFor(cat, frame, state)) {
      if (state.count(cat) >= n) break;
      const rows = (typeof ph.rows === "function" ? ph.rows() : ph.rows).filter((r) => !state.blocked.has(r.url));
      console.error(`[${cat}/${ph.phase}] replay: ${state.count(cat)}/${n} accepted, ${rows.length} candidates in frame`);
      for (const row of rows) {
        if (state.count(cat) >= n) break;
        const cand = { ...row, category: cat, phase: ph.phase, domain: row.domain ?? etld1(row.url) };
        const old = byKey.get(keyOf(cat, cand.url));
        if (!old) await fetchNow(cat, cand, null);
        else if (old.outcome === "accepted") {
          const why = refusal(cat, cand.domain, old.detail);
          if (why) displace(cat, cand, old, why);
          else {
            state.accept(old);
            accepted.add(keyOf(cat, cand.url));
            settled.add(keyOf(cat, cand.url));
          }
        } else if (isStateDependent(old.reason) && !refusal(cat, cand.domain, old.detail)) await fetchNow(cat, cand, old);
        // any other exclusion does not depend on the state: it stays as recorded
      }
    }
    // pages accepted before that the replay never reached because the category is complete: the sequential walk would not have visited them
    for (const old of records) {
      if (old.category !== cat || old.outcome !== "accepted" || settled.has(keyOf(cat, old.url))) continue;
      displace(cat, old, old, "replay:target-reached");
    }
  }
  return { events };
}
