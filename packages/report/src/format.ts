/** Deterministic text formatting. No Intl/locale: the output must be byte-stable across machines. */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for HTML element content and quoted attribute values. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const MINUS = "−";

/** Fixed-decimal number with a true minus sign and no "-0.000". */
export function num(x: number, decimals = 3): string {
  if (!Number.isFinite(x)) return "n/a";
  const s = x.toFixed(decimals);
  if (/^-0(\.0+)?$/.test(s)) return s.slice(1);
  return s.startsWith("-") ? MINUS + s.slice(1) : s;
}

/** Like `num` but always carries a sign ("+0.182", "−0.041", "0.000"). */
export function signed(x: number, decimals = 3): string {
  const s = num(x, decimals);
  return x > 0 && s !== num(0, decimals) ? `+${s}` : s;
}

/** Integer with a comma every three digits. */
export function int(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  const s = Math.round(Math.abs(n)).toString();
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? MINUS + grouped : grouped;
}

/** A ratio in [0, 1] as a percentage with one decimal ("17.5%"). */
export function pct(x: number, decimals = 1): string {
  return Number.isFinite(x) ? `${num(x * 100, decimals)}%` : "n/a";
}

/** `[lo, hi]` with the same decimals as the point estimate. */
export function ci(c: readonly [number, number], decimals = 3): string {
  return `[${num(c[0], decimals)}, ${num(c[1], decimals)}]`;
}

/** "sha256:c29821…bb7f": enough to recognise an id; the full value stays in the title/aria. */
export function shortId(id: string): string {
  const m = /^(sha256:)([0-9a-f]{64})$/.exec(id);
  return m ? `${m[1]}${m[2]!.slice(0, 8)}…${m[2]!.slice(-6)}` : id;
}

/** "5.7×" for a kept/full token ratio, or "n/a" for a degenerate one. */
export function times(ratio: number): string {
  return ratio > 0 && Number.isFinite(ratio) ? `${num(1 / ratio, 1)}×` : "n/a";
}

/** Plural helper for the gate banner ("1 gate", "3 gates"). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${int(n)} ${n === 1 ? one : many}`;
}

/** A reduction factor already expressed as full/kept: "50.0×". */
export function factor(x: number): string {
  return Number.isFinite(x) && x > 0 ? `${num(x, 1)}×` : "n/a";
}

/** Fixed decimals with trailing zeros (and a dangling point) removed: "112.4", "150", "2.5". */
export function trimmed(x: number, maxDecimals: number): string {
  const s = num(x, maxDecimals);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Display rule per gate unit: decimals, whether trailing zeros are kept, and the suffix. */
interface UnitRule {
  decimals: number;
  fixed: boolean;
  suffix: string;
}
const UNIT_RULES: Record<string, UnitRule> = {
  ms: { decimals: 1, fixed: false, suffix: " ms" },
  x: { decimals: 1, fixed: false, suffix: "×" },
  pp: { decimals: 1, fixed: false, suffix: " pp" },
  f1: { decimals: 3, fixed: true, suffix: " F1" },
  kappa: { decimals: 3, fixed: true, suffix: " κ" },
  ratio: { decimals: 3, fixed: true, suffix: "" },
};

/**
 * A value in the unit of a structured gate (`ms`, `x`, `f1`, `pp`, `bytes`, ...), with sensible
 * decimals per unit: "112.4 ms", "11.5×", "0.182 F1", "82.0 KiB". `extra` adds decimals (see `unitPair`).
 * No unit: the legacy three fixed decimals. An unknown unit is shown as a suffix.
 */
export function unitValue(x: number, unit: string | undefined, o: { signed?: boolean; extra?: number } = {}): string {
  if (!Number.isFinite(x)) return "n/a";
  const extra = o.extra ?? 0;
  const sign = (s: string): string => (o.signed && x > 0 && !/^0(\.0+)?(?![\d.])/.test(s) ? `+${s}` : s);
  if (unit === "bytes") {
    const a = Math.abs(x);
    if (a < 1024) return sign(`${int(x)} B`);
    const [div, name] = a < 1024 * 1024 ? [1024, "KiB"] : [1024 * 1024, "MiB"];
    return sign(`${num(x / div, 1 + extra)} ${name}`);
  }
  if (unit === undefined) return sign(num(x, 3 + extra));
  const rule = UNIT_RULES[unit] ?? { decimals: 3, fixed: false, suffix: ` ${unit}` };
  const body = rule.fixed ? num(x, rule.decimals + extra) : trimmed(x, rule.decimals + extra);
  return sign(body + rule.suffix);
}

/** Formats two values of one unit (observed and threshold) with enough decimals to tell them apart. */
export function unitPair(a: number, b: number, unit: string | undefined, o: { signed?: boolean } = {}): [string, string] {
  for (let extra = 0; extra < 3; extra++) {
    const sa = unitValue(a, unit, { ...o, extra });
    const sb = unitValue(b, unit, { ...o, extra });
    if (sa !== sb || a === b) return [sa, sb];
  }
  return [unitValue(a, unit, { ...o, extra: 3 }), unitValue(b, unit, { ...o, extra: 3 })];
}

/** `[lo, hi]` in a gate's unit; the unit is repeated on each bound so the interval reads alone. */
export function unitCi(c: readonly [number, number], unit: string | undefined, o: { signed?: boolean } = {}): string {
  return `[${unitValue(c[0], unit, o)}, ${unitValue(c[1], unit, o)}]`;
}

const COMPARATOR_SYMBOL: Record<string, string> = { ">=": "≥", "<=": "≤", ">": ">", "<": "<", "==": "=" };
export const comparatorSymbol = (c: string): string => COMPARATOR_SYMBOL[c] ?? c;
