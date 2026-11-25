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
