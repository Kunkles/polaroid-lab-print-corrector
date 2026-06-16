/* Phase 2 solver: turn measured (input -> printed) patch pairs into a
   correction that pre-distorts an image so the print lands on target.

   Assumes the film responds per-channel (each output channel depends mainly
   on its own input). That holds well enough for a first calibration and
   keeps the inverse robust from ~100 noisy samples; residual cross-channel
   cast is mopped up by an identity-regularized 3x3 afterward.

   The key statistical point: the digital input is the *controlled* variable
   and the scanned print is the *noisy measurement*, so we regress printed on
   input (a well-posed forward model F), force it monotonic, then invert F
   analytically to get the correction G = F^-1. Regressing the other way would
   suffer regression-to-the-mean and systematically under-correct. */

async function collectPairs(scans) {
  const pairs = [];
  for (const { file, inputs } of scans) {
    const im = await loadImageData(file + '?v=' + Date.now());
    const ex = extractChart(im);
    const resp = stripResponse(ex.strips);
    ex.patches.forEach((raw, i) => {
      pairs.push({ input: inputs[i], printed: normalizeColor(raw, resp) });
    });
  }
  return pairs;
}

/* Forward per-channel response F_c(s) = E[printed | input=s], via
   Nadaraya-Watson regression over an input grid, forced strictly
   increasing so it can be inverted. Returns { eval, grid }. */
function fitForward(samples, { h = 0.08, nodes = 65 } = {}) {
  const grid = new Float64Array(nodes);
  for (let k = 0; k < nodes; k++) {
    const s = k / (nodes - 1);
    let wsum = 0, psum = 0;
    for (const smp of samples) {
      const w = Math.exp(-(((smp.s - s) / h) ** 2));
      wsum += w; psum += w * smp.p;
    }
    grid[k] = wsum > 1e-9 ? psum / wsum : s;
  }
  for (let k = 1; k < nodes; k++)
    if (grid[k] <= grid[k - 1]) grid[k] = grid[k - 1] + 1e-4; // strictly up
  const evalF = (s) => {
    const x = clamp01(s) * (nodes - 1);
    const i = Math.min(nodes - 2, x | 0);
    return grid[i] + (grid[i + 1] - grid[i]) * (x - i);
  };
  return { eval: evalF, grid, nodes };
}

/* Invert a forward grid: G(p) = the input s whose print equals p. Targets
   below the film's black floor clamp to 0, above its white ceiling to 1. */
function invertForward(fwd) {
  const { grid, nodes } = fwd;
  return (p) => {
    p = clamp01(p);
    if (p <= grid[0]) return 0;
    if (p >= grid[nodes - 1]) return 1;
    let lo = 0, hi = nodes - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (grid[mid] < p) lo = mid; else hi = mid;
    }
    const t = (p - grid[lo]) / (grid[hi] - grid[lo]);
    return (lo + t) / (nodes - 1);
  };
}

/* Solve 3x3 M minimizing |M·printed - input|^2 + lambda*|M - I|^2.
   Pulled toward identity so collinear gray samples can't make it explode. */
function fitChroma(pairs, lambda) {
  const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const Atb = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; // Atb[outRow][col]
  for (const { input, printed } of pairs)
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        AtA[r][c] += printed[r] * printed[c];
        Atb[c][r] += printed[r] * input[c];
      }
  if (lambda == null) lambda = 0.1 * (AtA[0][0] + AtA[1][1] + AtA[2][2]) / 3;
  const M = [];
  for (let row = 0; row < 3; row++) {
    const A = AtA.map((r) => [...r]);
    for (let i = 0; i < 3; i++) A[i][i] += lambda;
    const rhs = [0, 1, 2].map((c) => Atb[c][row] + lambda * (c === row ? 1 : 0));
    M.push(gauss(A, rhs));
  }
  return M;
}

function applyMat(M, v) {
  return [0, 1, 2].map((r) => M[r][0] * v[0] + M[r][1] * v[1] + M[r][2] * v[2]);
}

/* Fit forward per channel, invert to a correction, add gentle chroma. */
function solveCorrection(pairs, { useChroma = true } = {}) {
  const perCh = [[], [], []];
  for (const { input, printed } of pairs)
    for (let c = 0; c < 3; c++) perCh[c].push({ s: input[c], p: printed[c] });

  const fwd = perCh.map((s) => fitForward(s));
  const inv = fwd.map(invertForward);
  const chroma = useChroma ? fitChroma(pairs) : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  const correct = (r, g, b) => {
    const tone = [inv[0](r), inv[1](g), inv[2](b)];
    const c = applyMat(chroma, tone);
    return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
  };
  const predictPrint = (r, g, b) => [fwd[0].eval(r), fwd[1].eval(g), fwd[2].eval(b)];

  return { correct, predictPrint, fwd, inv, chroma };
}

/* Average raw strip readings across charts → anchors for un-normalizing a
   prediction back into real-scan appearance (see unNormalizeColor). */
function rawAnchors(scans) {
  const acc = { black: [0, 0, 0], gray: [0, 0, 0], white: [0, 0, 0] };
  for (const r of scans)
    for (const k of ['black', 'gray', 'white'])
      for (let c = 0; c < 3; c++) acc[k][c] += r[k][c] / scans.length;
  return {
    black: acc.black.map((v) => +v.toFixed(5)),
    gray: acc.gray.map((v) => +v.toFixed(5)),
    white: acc.white.map((v) => +v.toFixed(5)),
    ref: scans[0].ref,
  };
}

/* Map a value from normalized (strip-referenced) space back to raw-scan
   appearance — the inverse of normalizeColor. Lets the preview show what a
   real print actually looks like instead of the brightened calibration space. */
function unNormalizeColor(rgb, A) {
  return rgb.map((v, c) => {
    const p = [[A.ref[0], A.black[c]], [A.ref[1], A.gray[c]], [A.ref[2], A.white[c]]];
    if (v <= p[0][0]) return clamp01(p[0][1]);
    if (v >= p[2][0]) return clamp01(p[2][1]);
    const seg = v <= p[1][0] ? [p[0], p[1]] : [p[1], p[2]];
    const t = (v - seg[0][0]) / (seg[1][0] - seg[0][0] || 1);
    return clamp01(seg[0][1] + t * (seg[1][1] - seg[0][1]));
  });
}

/* Serialize a fitted model to a plain object the app can load and reuse
   without the scans (per-channel forward grids, chroma, raw anchors). */
function exportCalibration(model, meta = {}, anchors = null) {
  return {
    version: 1,
    meta,
    nodes: model.fwd[0].nodes,
    forwardGrids: model.fwd.map((f) => Array.from(f.grid).map((v) => +v.toFixed(5))),
    chroma: model.chroma.map((r) => r.map((v) => +v.toFixed(5))),
    rawAnchors: anchors,
  };
}

/* Rebuild correction + forward fns from a serialized calibration. */
function loadCalibration(calib) {
  const fwd = calib.forwardGrids.map((g) => {
    const grid = Float64Array.from(g);
    return { eval: (s) => {
      const x = clamp01(s) * (calib.nodes - 1);
      const i = Math.min(calib.nodes - 2, x | 0);
      return grid[i] + (grid[i + 1] - grid[i]) * (x - i);
    }, grid, nodes: calib.nodes };
  });
  const inv = fwd.map(invertForward);
  const M = calib.chroma;
  const correct = (r, g, b) => {
    const tone = [inv[0](r), inv[1](g), inv[2](b)];
    const c = applyMat(M, tone);
    return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
  };
  const predictPrint = (r, g, b) => [fwd[0].eval(r), fwd[1].eval(g), fwd[2].eval(b)];
  const A = calib.rawAnchors;
  // real-scan appearance: un-stretch the normalized prediction back to raw
  const predictPrintRaw = A
    ? (r, g, b) => unNormalizeColor(predictPrint(r, g, b), A)
    : predictPrint;
  return { correct, predictPrint, predictPrintRaw, anchors: A, fwd, inv, chroma: M };
}

/* Honest validation: fit on `train` pairs, predict the printed color of every
   `test` patch from its known input, and report error vs the measured print.
   Cross-chart (train v1 / test v2) also exercises the per-frame AE difference. */
function forwardPredictionError(train, test) {
  const model = solveCorrection(train, { useChroma: false });
  let sum = 0, max = 0;
  for (const { input, printed } of test) {
    const pred = model.predictPrint(...input);
    for (let c = 0; c < 3; c++) {
      const e = Math.abs(pred[c] - printed[c]);
      sum += e; max = Math.max(max, e);
    }
  }
  return { mean: sum / (test.length * 3), max };
}
