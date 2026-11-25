import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BudgetExceededError, Ledger } from "../src/index.js";
import { cleanupTmp, tmpDir } from "./helpers.js";

afterAll(cleanupTmp);

const ledgerAt = (cap: number, dir = tmpDir()): Ledger => new Ledger(join(dir, "ledger.jsonl"), cap);

describe("Ledger hard cap", () => {
  it("allows spending up to the cap and refuses the call that would pass it", () => {
    const l = ledgerAt(1);
    l.reserve(0.6).commit();
    l.reserve(0.4).commit(); // exactly the cap
    expect(l.spentUSD()).toBeCloseTo(1, 9);
    expect(() => l.reserve(0.01)).toThrow(BudgetExceededError);
    expect(l.spentUSD()).toBeCloseTo(1, 9); // the refused call was not recorded as spending
  });

  it("counts open reservations against the cap (a crash cannot hide spending)", () => {
    const l = ledgerAt(1);
    l.reserve(0.7); // never committed
    expect(l.spentUSD()).toBeCloseTo(0.7, 9);
    expect(() => l.reserve(0.4)).toThrow(BudgetExceededError);
  });

  it("release gives the money back; commit may record the real (lower or higher) cost", () => {
    const l = ledgerAt(1);
    l.reserve(0.8).release();
    expect(l.spentUSD()).toBe(0);
    l.reserve(0.8).commit(0.3);
    expect(l.spentUSD()).toBeCloseTo(0.3, 9);
    l.reserve(0.1).commit(0.9); // real cost above the estimate is recorded as it happened
    expect(l.spentUSD()).toBeCloseTo(1.2, 9);
    expect(() => l.reserve(0.01)).toThrow(BudgetExceededError);
  });

  it("is cumulative across ledger instances over the same file", () => {
    const dir = tmpDir();
    ledgerAt(1, dir).reserve(0.9).commit();
    expect(() => ledgerAt(1, dir).reserve(0.2)).toThrow(/cap exceeded/);
    expect(ledgerAt(2, dir).remainingUSD()).toBeCloseTo(1.1, 9);
  });

  it("a cap of 0 refuses any paid call but allows free ones", () => {
    const l = ledgerAt(0);
    expect(() => l.reserve(0.0001)).toThrow(BudgetExceededError);
    l.reserve(0).commit();
  });

  it("logs reject lines with who asked, and entries are append-only JSONL", () => {
    const l = ledgerAt(0.1);
    expect(() => l.reserve(0.5, { run_id: "r1", stage_id: "label", note: "claude call" })).toThrow();
    const [e] = l.entries();
    expect(e).toMatchObject({ event: "reject", cost_usd: 0.5, cap_usd: 0.1, run_id: "r1", stage_id: "label", note: "claude call" });
    expect(typeof e?.ts).toBe("string");
  });

  it("rejects nonsense amounts and double settlement", () => {
    const l = ledgerAt(1);
    expect(() => l.reserve(-1)).toThrow(RangeError);
    expect(() => l.reserve(Number.NaN)).toThrow(RangeError);
    expect(() => new Ledger("x", -1)).toThrow(RangeError);
    const r = l.reserve(0.1);
    r.commit();
    expect(() => r.commit()).toThrow(/already closed/);
    expect(() => r.release()).toThrow(/already closed/);
  });
});
