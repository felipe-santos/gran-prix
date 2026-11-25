import { esc, num } from "./format.js";

/**
 * Inline SVG charts. Colors come from CSS custom properties (see styles.ts), so the charts follow
 * the light/dark theme without any script. Series are told apart by SHAPE and gray level, never
 * by hue: s0 is the model (accent), s1..s4 are baselines (grays).
 */

export type Shape = "circle" | "square" | "diamond" | "triangle" | "cross";
export interface Series {
  name: string;
  shape: Shape;
  cls: string;
}

const BASELINE_SHAPES: Shape[] = ["square", "diamond", "triangle", "cross"];

/** Model first (accent circle), then one gray, differently shaped marker per baseline. */
export function seriesFor(modelName: string, baselines: string[]): Series[] {
  return [
    { name: modelName, shape: "circle", cls: "s0" },
    ...baselines.map((name, i) => ({
      name,
      shape: BASELINE_SHAPES[i % BASELINE_SHAPES.length] as Shape,
      cls: `s${(i % 4) + 1}`,
    })),
  ];
}

/** Coordinate with at most 2 decimals and no trailing zeros, for stable SVG output. */
const n2 = (v: number): string => String(Math.round(v * 100) / 100);

export function marker(shape: Shape, cx: number, cy: number, cls: string, r = 4.6): string {
  const x = n2(cx);
  const y = n2(cy);
  const c = `class="mk ${cls}"`;
  switch (shape) {
    case "circle":
      return `<circle ${c} cx="${x}" cy="${y}" r="${n2(r + 0.4)}"/>`;
    case "square":
      return `<rect ${c} x="${n2(cx - r)}" y="${n2(cy - r)}" width="${n2(2 * r)}" height="${n2(2 * r)}"/>`;
    case "diamond":
      return `<polygon ${c} points="${x},${n2(cy - r - 1)} ${n2(cx + r + 1)},${y} ${x},${n2(cy + r + 1)} ${n2(cx - r - 1)},${y}"/>`;
    case "triangle":
      return `<polygon ${c} points="${x},${n2(cy - r - 1)} ${n2(cx + r + 1)},${n2(cy + r)} ${n2(cx - r - 1)},${n2(cy + r)}"/>`;
    case "cross":
      return `<path class="mk x ${cls}" d="M${n2(cx - r)} ${n2(cy - r)}L${n2(cx + r)} ${n2(cy + r)}M${n2(cx - r)} ${n2(cy + r)}L${n2(cx + r)} ${n2(cy - r)}"/>`;
  }
}

/** Legend swatch as a tiny inline SVG (same markers as the plot). */
export function legendMarker(s: Series): string {
  return `<svg class="lg" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">${marker(s.shape, 7, 7, s.cls, 4)}</svg>`;
}

export function legend(series: Series[]): string {
  const items = series.map((s) => `<li>${legendMarker(s)}<span>${esc(s.name)}</span></li>`).join("");
  return `<ul class="legend">${items}</ul>`;
}

/** "Nice" axis for a data range: step in {1,2,5}x10^k, about 4-6 ticks, domain padded to the ticks. */
export function niceAxis(min: number, max: number): { domain: [number, number]; ticks: number[] } {
  const lo = Math.min(min, 0);
  const hi = Math.max(max, 0);
  const span = hi - lo || 1;
  const raw = span / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag;
  const d0 = Math.floor(lo / step + 1e-9) * step;
  const d1 = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let t = d0; t <= d1 + step / 2; t += step) ticks.push(Math.round(t / step) * step);
  return { domain: [d0, d1], ticks };
}

export const UNIT_AXIS = { domain: [0, 1] as [number, number], ticks: [0, 0.25, 0.5, 0.75, 1] };

export interface DwPoint {
  value: number;
  ci?: readonly [number, number];
}
export interface DwRow {
  label: string;
  /** One entry per series; `undefined` leaves a gap (that series has no value for this row). */
  points: (DwPoint | undefined)[];
}
export interface DwOptions {
  id: string;
  title: string;
  desc: string;
  rows: DwRow[];
  series: Series[];
  domain: [number, number];
  ticks: number[];
  axisLabel: string;
  decimals: number;
  /** Draw an emphasised reference line at 0 (delta charts). */
  zeroLine?: boolean;
}

const W = 360;
const PX0 = 14;
const PX1 = 346;
const LANE = 15;

/** Dot-and-whisker chart: one row per category, one lane per series, whiskers = 95% CI. */
export function dotWhisker(o: DwOptions): string {
  const [d0, d1] = o.domain;
  const x = (v: number): number => PX0 + ((Math.min(Math.max(v, d0), d1) - d0) / (d1 - d0)) * (PX1 - PX0);
  const rowH = 24 + o.series.length * LANE;
  const axisY = 6 + o.rows.length * rowH + 4;
  const H = axisY + 38;
  const out: string[] = [];
  out.push(
    `<svg class="chart" id="${esc(o.id)}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${esc(o.id)}-t ${esc(o.id)}-d">`,
    `<title id="${esc(o.id)}-t">${esc(o.title)}</title><desc id="${esc(o.id)}-d">${esc(o.desc)}</desc>`,
  );
  for (const t of o.ticks) {
    const gx = n2(x(t));
    out.push(`<line class="grid" x1="${gx}" y1="4" x2="${gx}" y2="${axisY}"/>`);
    out.push(`<text class="tick" x="${gx}" y="${axisY + 14}" text-anchor="middle">${num(t, o.decimals === 3 ? 2 : o.decimals)}</text>`);
  }
  if (o.zeroLine && d0 < 0 && d1 > 0) out.push(`<line class="zero" x1="${n2(x(0))}" y1="4" x2="${n2(x(0))}" y2="${axisY}"/>`);
  out.push(`<line class="axis" x1="${PX0}" y1="${axisY}" x2="${PX1}" y2="${axisY}"/>`);
  out.push(`<text class="axl" x="${(PX0 + PX1) / 2}" y="${axisY + 32}" text-anchor="middle">${esc(o.axisLabel)}</text>`);
  o.rows.forEach((row, i) => {
    const y0 = 6 + i * rowH;
    out.push(`<text class="rowl" x="${PX0}" y="${y0 + 12}">${esc(row.label)}</text>`);
    if (i > 0) out.push(`<line class="sep" x1="${PX0}" y1="${y0 - 2}" x2="${PX1}" y2="${y0 - 2}"/>`);
    o.series.forEach((s, k) => {
      const p = row.points[k];
      if (!p) return;
      const y = y0 + 24 + k * LANE;
      if (p.ci) {
        const a = n2(x(p.ci[0]));
        const b = n2(x(p.ci[1]));
        out.push(`<g class="wh ${s.cls}"><line x1="${a}" y1="${y}" x2="${b}" y2="${y}"/><line x1="${a}" y1="${y - 4.5}" x2="${a}" y2="${y + 4.5}"/><line x1="${b}" y1="${y - 4.5}" x2="${b}" y2="${y + 4.5}"/></g>`);
      }
      out.push(`<g><title>${esc(`${s.name}, ${row.label}: ${num(p.value, o.decimals)}${p.ci ? ` [${num(p.ci[0], o.decimals)}, ${num(p.ci[1], o.decimals)}]` : ""}`)}</title>${marker(s.shape, x(p.value), y, s.cls)}</g>`);
    });
  });
  out.push("</svg>");
  return out.join("");
}

export interface XyOptions {
  id: string;
  title: string;
  desc: string;
  xLabel: string;
  yLabel: string;
  /** Polylines in data coordinates (both axes 0..1). */
  lines?: { pts: [number, number][]; cls: string; dashed?: boolean }[];
  /** Markers in data coordinates. */
  marks?: { x: number; y: number; shape: Shape; cls: string; ring?: boolean; tip: string }[];
  /** Direct labels, placed next to a data point. */
  labels?: { x: number; y: number; text: string }[];
}

const XW = 360;
const XH = 330;
const XL = 46;
const XR = 342;
const XT = 14;
const XB = 270;

/** Unit-square line/scatter chart with labeled axes (PR curve, reliability diagram). */
export function xyChart(o: XyOptions): string {
  const sx = (v: number): number => XL + v * (XR - XL);
  const sy = (v: number): number => XB - v * (XB - XT);
  const out: string[] = [];
  out.push(
    `<svg class="chart" id="${esc(o.id)}" viewBox="0 0 ${XW} ${XH}" role="img" aria-labelledby="${esc(o.id)}-t ${esc(o.id)}-d">`,
    `<title id="${esc(o.id)}-t">${esc(o.title)}</title><desc id="${esc(o.id)}-d">${esc(o.desc)}</desc>`,
  );
  for (const t of UNIT_AXIS.ticks) {
    out.push(`<line class="grid" x1="${n2(sx(t))}" y1="${XT}" x2="${n2(sx(t))}" y2="${XB}"/>`);
    out.push(`<line class="grid" x1="${XL}" y1="${n2(sy(t))}" x2="${XR}" y2="${n2(sy(t))}"/>`);
    out.push(`<text class="tick" x="${n2(sx(t))}" y="${XB + 14}" text-anchor="middle">${num(t, 2)}</text>`);
    out.push(`<text class="tick" x="${XL - 6}" y="${n2(sy(t) + 3.5)}" text-anchor="end">${num(t, 2)}</text>`);
  }
  out.push(`<line class="axis" x1="${XL}" y1="${XB}" x2="${XR}" y2="${XB}"/><line class="axis" x1="${XL}" y1="${XT}" x2="${XL}" y2="${XB}"/>`);
  out.push(`<text class="axl" x="${(XL + XR) / 2}" y="${XB + 34}" text-anchor="middle">${esc(o.xLabel)}</text>`);
  out.push(`<text class="axl" transform="translate(12 ${(XT + XB) / 2}) rotate(-90)" text-anchor="middle">${esc(o.yLabel)}</text>`);
  for (const l of o.lines ?? []) {
    const pts = l.pts.map(([px, py]) => `${n2(sx(px))},${n2(sy(py))}`).join(" ");
    out.push(`<polyline class="ln ${l.cls}${l.dashed ? " dashed" : ""}" points="${pts}"/>`);
  }
  for (const m of o.marks ?? []) {
    const ring = m.ring ? `<circle class="ring ${m.cls}" cx="${n2(sx(m.x))}" cy="${n2(sy(m.y))}" r="10"/>` : "";
    out.push(`<g><title>${esc(m.tip)}</title>${ring}${marker(m.shape, sx(m.x), sy(m.y), m.cls, m.ring ? 5.2 : 4.6)}</g>`);
  }
  for (const l of o.labels ?? []) {
    const left = l.x > 0.55;
    out.push(`<text class="dlab" x="${n2(sx(l.x) + (left ? -16 : 16))}" y="${n2(sy(l.y) + (l.y > 0.6 ? 46 : -14))}" text-anchor="${left ? "end" : "start"}">${esc(l.text)}</text>`);
  }
  out.push("</svg>");
  return out.join("");
}
