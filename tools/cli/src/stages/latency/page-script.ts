/**
 * The code that runs INSIDE the measured page, as a plain JavaScript string (so no bundler or compiler touches it).
 * `page.evaluate(PAGE_RUNNER, args)` calls it once per repetition, after the page has loaded and the features bundle
 * (`window.__gpFeatures`) is installed.
 *
 * Before the clock starts the runner lets the page render `waitFrames` frames (two by default), so that style and layout
 * are clean as they are when the real probe runs after the settle wait.
 *
 * What is timed (all with `performance.now()` in the page, so the CPU throttle applies to every part and network,
 * Playwright and the CDP round trips are never counted):
 *
 *   probe      `__gpFeatures.probe({ settle: false, stamp, lateCheckMs: 0 })`: the walk that reads the live DOM,
 *              computed style and layout. `settle: false` skips the wait for DOM quiet (600 ms of wall clock, not CPU).
 *              With `stamp` the probe ends with one `setTimeout(0)` tick; its cost is measured apart (`timer_floor_ms`)
 *              and stays inside `probe_ms`.
 *   vectorize  `vectorizeMatrix(snapshot, schema)`: the 59-feature matrix of the rows that survive the prefilter.
 *   init       evaluating `model.generated.ts` (decode of the base64 weights): paid once per page load.
 *   infer      z-score of `feature_spec`, `predictLogitsBatch`, calibration and activation of `output_spec`, for every row.
 *
 * `total_ms` = probe + vectorize + init + infer, taken from one continuous clock (not the sum of rounded parts).
 */
export const PAGE_RUNNER = `async (a) => {
  const api = window.__gpFeatures;
  if (!api) throw new Error("gp-features bundle is not installed in this page");
  // The page has been rendered before the clock starts: in real use the probe runs after the DOM-quiet wait (600 ms of
  // frames), so style and layout are clean and the probe pays only for what it reads, not for the page's own first
  // layout. waitFrames = 0 keeps that first layout inside the probe (a pessimistic bound).
  for (let i = 0; i < a.waitFrames; i++) {
    await new Promise((r) => { const t = setTimeout(r, 3000); requestAnimationFrame(() => { clearTimeout(t); r(); }); });
  }
  const f0 = performance.now();
  await new Promise((r) => setTimeout(r, 0));
  const timerFloor = performance.now() - f0;

  const t0 = performance.now();
  const raw = await api.probe({ settle: false, stamp: a.stamp, lateCheckMs: 0 });
  const t1 = performance.now();
  const snapshot = { snapshot_id: "sha256:" + "0".repeat(64), page: raw.page, doc: raw.doc, nodes: raw.nodes };
  const m = api.vectorizeMatrix(snapshot, a.schema);
  const t2 = performance.now();
  const model = new Function(a.moduleBody)();
  const t3 = performance.now();

  const sp = a.spec;
  const n = m.unit_ids.length;
  const dim = sp.dim;
  const k = sp.outputDim;
  const xn = new Float32Array(n * dim);
  const norm = sp.normalization;
  if (norm.kind === "zscore") {
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < dim; c++) xn[r * dim + c] = (m.x[r * dim + c] - norm.mean[c]) / (norm.std[c] + norm.eps);
    }
  } else {
    xn.set(m.x);
  }
  const logits = model.predictLogitsBatch(xn, n);
  const scores = new Float32Array(n * k);
  const row = new Float64Array(k);
  const cal = sp.calibration;
  for (let r = 0; r < n; r++) {
    for (let j = 0; j < k; j++) row[j] = logits[r * k + j];
    if (sp.activation === "sigmoid") {
      const z = cal.kind === "platt" ? cal.a * row[0] + cal.b : row[0];
      row[0] = 1 / (1 + Math.exp(-z));
    } else {
      if (cal.kind === "temperature") for (let j = 0; j < k; j++) row[j] = row[j] / cal.t;
      if (sp.activation === "softmax") {
        let max = -Infinity;
        for (let j = 0; j < k; j++) max = Math.max(max, row[j]);
        let sum = 0;
        for (let j = 0; j < k; j++) { row[j] = Math.exp(row[j] - max); sum += row[j]; }
        for (let j = 0; j < k; j++) row[j] = row[j] / sum;
      }
    }
    for (let j = 0; j < k; j++) scores[r * k + j] = row[j];
  }
  const t4 = performance.now();

  let scoreSum = 0;
  for (let i = 0; i < scores.length; i++) scoreSum += scores[i];
  const out = {
    probe_ms: t1 - t0,
    vectorize_ms: t2 - t1,
    init_ms: t3 - t2,
    infer_ms: t4 - t3,
    total_ms: t4 - t0,
    timer_floor_ms: timerFloor,
    elements: raw.nodes.length,
    rows: n,
    score_sum: scoreSum,
    dom_elements: document.getElementsByTagName("*").length,
  };
  if (a.verify) {
    out.features = Array.from(m.x);
    out.scores = Array.from(scores);
  }
  return out;
}`;

/**
 * Fixed busy loop used to check that the CPU throttle took effect (run unthrottled and throttled, compare). About 100 ms
 * unthrottled, the size of the probe's own tasks: in Chromium 158 the CDP throttle slows a 10 ms task by 4x but a
 * 100 ms one by less, so a short loop would report a slowdown the real work does not get.
 */
export const BUSY_LOOP = `() => {
  const t = performance.now();
  let s = 0;
  for (let i = 0; i < 40000000; i++) s += Math.sqrt(i);
  return { ms: performance.now() - t, s };
}`;

/** One in-page result of PAGE_RUNNER (the `features` and `scores` arrays only with `verify`). */
export interface RunnerResult {
  probe_ms: number;
  vectorize_ms: number;
  init_ms: number;
  infer_ms: number;
  total_ms: number;
  timer_floor_ms: number;
  elements: number;
  rows: number;
  score_sum: number;
  dom_elements: number;
  features?: number[];
  scores?: number[];
}
