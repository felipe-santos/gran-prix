/**
 * Calibration of the CDP CPU throttle (G5, "throttle: calibrated").
 *
 * `Emulation.setCPUThrottlingRate(N)` does not slow a long task down by N: in Chromium 158 a ~100 ms loop gets 1.9 to 2.4x
 * slower at rate 4. The calibration looks for the rate whose effect on that reference loop IS the requested factor (4.0 within
 * a tolerance), and the page measurement then runs with that rate. The search is a pure function of a `measure(rate)` callback
 * (the best time of the reference loop at that rate), so it is tested without a browser.
 *
 * The slowdown grows with the rate but less than proportionally, so the update `rate <- rate * target / ratio` converges from
 * either side; the step with the ratio closest to the target is kept.
 */

export interface CalibrationStep {
  rate: number;
  ratio: number;
}

export interface Calibration {
  /** The slowdown asked for (4 for G5). */
  target: number;
  tolerance: number;
  /** Best time of the reference loop with no throttle. */
  unthrottled_ms: number;
  /** The CDP rate to use: the step whose ratio is closest to the target. */
  rate: number;
  /** Slowdown of the reference loop at `rate`, as measured during the search. */
  ratio: number;
  converged: boolean;
  steps: CalibrationStep[];
}

export interface CalibrateOptions {
  target: number;
  /** Accept a ratio within `target +- tolerance` (default 0.2). */
  tolerance?: number;
  maxSteps?: number;
  maxRate?: number;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** `measure(rate)`: best time in ms of the reference loop with the CDP rate set to `rate` (1 = unthrottled). */
export async function calibrateRate(measure: (rate: number) => Promise<number>, o: CalibrateOptions): Promise<Calibration> {
  const { target } = o;
  const tolerance = o.tolerance ?? 0.2;
  const maxSteps = o.maxSteps ?? 8;
  const maxRate = o.maxRate ?? 64;
  if (!(target > 1)) throw new Error(`calibration target must be > 1, got ${target}`);
  const unthrottled = await measure(1);
  if (!(unthrottled > 0)) throw new Error(`the reference loop took ${unthrottled} ms unthrottled`);
  const steps: CalibrationStep[] = [];
  let rate = target;
  let converged = false;
  for (let i = 0; i < maxSteps; i++) {
    const ratio = (await measure(rate)) / unthrottled;
    steps.push({ rate: round2(rate), ratio: round2(ratio) });
    if (Math.abs(ratio - target) <= tolerance) { converged = true; break; }
    const next = Math.min(maxRate, Math.max(1, round2(rate * (target / ratio))));
    if (next === round2(rate)) break; // clamped at a bound, or the update no longer moves
    rate = next;
  }
  const best = steps.reduce((a, b) => (Math.abs(b.ratio - target) < Math.abs(a.ratio - target) ? b : a));
  return { target, tolerance, unthrottled_ms: round2(unthrottled), rate: best.rate, ratio: best.ratio, converged, steps };
}
