import { describe, expect, it } from "vitest";
import { FakeClaudeTransport, claudeOverhead, countTokensClaude, iqr, median, quantile, summarizeByStratum, summarizeRatios, tokenDrift } from "../src/index.js";

describe("quantiles (type 7, the numpy default)", () => {
  it("matches known values", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantile([1, 2, 3, 4], 0.75)).toBe(3.25);
    expect(quantile([5], 0.9)).toBe(5);
    expect(quantile([], 0.5)).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(iqr([1, 2, 3, 4, 5])).toEqual([2, 4]);
  });
});

describe("summarizeRatios: r_p = tok(D) / tok(output), median and IQR, pooled as secondary", () => {
  it("computes the per-page reduction, its median and IQR, and the pooled ratio", () => {
    const s = summarizeRatios([
      { full: 1000, out: 100 }, // 10x
      { full: 600, out: 200 }, // 3x
      { full: 400, out: 50 }, // 8x
    ]);
    expect(s).toMatchObject({ n_pages: 3, n_empty: 0, n_undefined: 0, full_tokens: 2000, kept_tokens: 350 });
    expect(s.median_reduction).toBe(8);
    expect(s.iqr_reduction).toEqual([5.5, 9]);
    expect(s.median_ratio).toBeCloseTo(0.125, 12);
    expect(s.pooled_ratio).toBeCloseTo(0.175, 12);
    expect(s.pooled_reduction).toBeCloseTo(2000 / 350, 12);
  });

  it("an empty output earns no credit: reduction 0, fraction kept 1, counted, and it stays in the median", () => {
    const s = summarizeRatios([
      { full: 1000, out: 0 },
      { full: 1000, out: 0 },
      { full: 1000, out: 100 },
    ]);
    expect(s.n_empty).toBe(2);
    expect(s.median_reduction).toBe(0);
    expect(s.median_ratio).toBe(1);
    expect(s.pooled_reduction).toBeCloseTo(3000 / 2100, 12);
    // a system that is empty everywhere cannot look good on any statistic
    const all = summarizeRatios([{ full: 500, out: 0 }, { full: 700, out: 0 }]);
    expect(all.median_reduction).toBe(0);
    expect(all.pooled_reduction).toBe(1); // no credit in the pooled view either: an empty page counts at its full size
    expect(all.pooled_ratio).toBe(1);
    expect(all.n_empty).toBe(2);
  });

  it("a page with an empty denominator has no ratio and is left out, and said so", () => {
    const s = summarizeRatios([{ full: 0, out: 0 }, { full: 100, out: 50 }]);
    expect(s).toMatchObject({ n_pages: 1, n_undefined: 1, median_reduction: 2 });
  });

  it("no pages: everything null", () => {
    expect(summarizeRatios([])).toMatchObject({ n_pages: 0, median_reduction: null, iqr_reduction: null, pooled_ratio: null });
  });

  it("per stratum, sorted by name, next to the overall", () => {
    const s = summarizeByStratum([
      { stratum: "spa", full: 900, out: 100 },
      { stratum: "article", full: 100, out: 50 },
      { stratum: "spa", full: 500, out: 100 },
    ]);
    expect(Object.keys(s.by_stratum)).toEqual(["article", "spa"]);
    expect(s.by_stratum["spa"]?.median_reduction).toBe(7);
    expect(s.by_stratum["article"]?.median_reduction).toBe(2);
    expect(s.n_pages).toBe(3);
  });
});

describe("Claude token-count hook (interface and fake only: no API call)", () => {
  it("counts through the transport and logs the request", async () => {
    const t = new FakeClaudeTransport(4, 5);
    expect(await countTokensClaude(t, "claude-test", "x".repeat(40))).toBe(15);
    expect(t.requests).toEqual([{ model: "claude-test", text: "x".repeat(40) }]);
    expect(await claudeOverhead(t, "claude-test")).toBe(6);
  });

  it("rejects a transport that answers nonsense", async () => {
    await expect(countTokensClaude({ countTokens: async () => ({ input_tokens: -1 }) }, "m", "a")).rejects.toThrow(/input_tokens/);
    await expect(countTokensClaude({ countTokens: async () => ({ input_tokens: 1.5 }) }, "m", "a")).rejects.toThrow(/input_tokens/);
  });

  it("the drift is claude / cl100k - 1, per page", () => {
    const d = tokenDrift([
      { cl100k: 100, claude: 110 },
      { cl100k: 200, claude: 190 },
      { cl100k: 50, claude: 55 },
      { cl100k: 0, claude: 7 },
    ]);
    expect(d.n_pages).toBe(3);
    expect(d.median_relative_drift).toBeCloseTo(0.1, 12);
    expect(d.min).toBeCloseTo(-0.05, 12);
    expect(d.max).toBeCloseTo(0.1, 12);
    expect(d.share_claude_higher).toBeCloseTo(2 / 3, 12);
    expect(tokenDrift([]).median_relative_drift).toBeNull();
  });
});
