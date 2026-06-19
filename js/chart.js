/* Calibration test charts for Phase 2.

   Charts are square (the Lab's image area is square) and designed to be
   recoverable from a casual phone photo of the print:
   - solid black corner fiducials locate the patch grid under perspective
   - gray reference strips (top and bottom) let the solver normalize the
     phone camera's white balance and exposure before reading patches
   - a 7x7 grid of 49 patches

   Print charts with the correction ZEROED — they must measure the raw
   Lab + film transfer, not the corrected one.

   Each chart's `patches` array is the ground truth the Phase 2 solver
   compares scanned patches against. */

const COLOR_CHART = (() => {
  const patches = [];

  // 7-step gray ramp: anchors the tone curve including the extremes
  for (let i = 0; i < 7; i++) patches.push([i / 6, i / 6, i / 6]);

  // 3x3x3 sweep of the RGB cube
  const levels = [0.2, 0.6, 1.0];
  for (const r of levels)
    for (const g of levels)
      for (const b of levels) patches.push([r, g, b]);

  // Memory colors: skin, sky, foliage, sand — where errors are most visible
  patches.push(
    [0.94, 0.78, 0.67],
    [0.78, 0.57, 0.45],
    [0.45, 0.30, 0.22],
    [0.47, 0.65, 0.85],
    [0.30, 0.45, 0.22],
    [0.76, 0.65, 0.45],
  );

  // Pastels and deep tones to fill out the interior of the gamut
  patches.push(
    [0.90, 0.70, 0.72],
    [0.88, 0.85, 0.62],
    [0.68, 0.85, 0.70],
    [0.65, 0.78, 0.88],
    [0.72, 0.65, 0.85],
    [0.88, 0.72, 0.60],
    [0.40, 0.12, 0.18],
    [0.12, 0.25, 0.40],
    [0.18, 0.35, 0.30],
  );

  return { id: 'color-v1', file: 'calibration-chart-color-v1.png', patches }; // 49
})();

/* Second color chart: complementary coverage. Printing both color charts
   gives the solver 98 samples instead of 49. */
const COLOR_CHART_2 = (() => {
  const patches = [];

  // Grays between chart 1's steps, plus a near-white
  for (let i = 0; i < 6; i++) {
    const v = i / 6 + 1 / 12;
    patches.push([v, v, v]);
  }
  patches.push([0.97, 0.97, 0.97]);

  // RGB cube at levels between chart 1's [0.2, 0.6, 1.0]
  const levels = [0.1, 0.45, 0.8];
  for (const r of levels)
    for (const g of levels)
      for (const b of levels) patches.push([r, g, b]);

  // Hue wheel halfway between the primaries/secondaries chart 1 covers
  patches.push(
    [1.0, 0.5, 0.0],
    [0.5, 1.0, 0.0],
    [0.0, 1.0, 0.5],
    [0.0, 0.5, 1.0],
    [0.5, 0.0, 1.0],
    [1.0, 0.0, 0.5],
  );

  // Wider skin-tone range + warm interior tones
  patches.push(
    [0.98, 0.86, 0.76],
    [0.87, 0.68, 0.55],
    [0.65, 0.45, 0.33],
    [0.55, 0.36, 0.26],
    [0.35, 0.22, 0.15],
    [0.92, 0.62, 0.55],
    [0.80, 0.50, 0.40],
    [0.70, 0.55, 0.50],
    [0.60, 0.50, 0.40],
  );

  return { id: 'color-v2', file: 'calibration-chart-color-v2.png', patches }; // 49
})();

const BW_CHART = (() => {
  const patches = [];

  // 25-step gray ramp: B&W calibration is mostly about the tone curve,
  // so sample it finely
  for (let i = 0; i < 25; i++) patches.push([i / 24, i / 24, i / 24]);

  // Primaries/secondaries at two levels: measures the film's spectral
  // response (how bright red vs green vs blue render in B&W)
  for (const lv of [1.0, 0.5]) {
    patches.push([lv, 0, 0], [0, lv, 0], [0, 0, lv], [0, lv, lv], [lv, 0, lv], [lv, lv, 0]);
  }

  // Memory colors — checks the spectral fit where it matters
  patches.push(
    [0.94, 0.78, 0.67],
    [0.78, 0.57, 0.45],
    [0.45, 0.30, 0.22],
    [0.47, 0.65, 0.85],
    [0.30, 0.45, 0.22],
    [0.76, 0.65, 0.45],
  );

  // Mixed tones to fill the grid
  patches.push(
    [0.90, 0.55, 0.25],
    [0.55, 0.30, 0.65],
    [0.25, 0.55, 0.55],
    [0.85, 0.85, 0.55],
    [0.35, 0.35, 0.60],
    [0.60, 0.20, 0.20],
  );

  return { id: 'bw-v1', file: 'calibration-chart-bw-v1.png', patches }; // 49
})();

function drawChart(canvas, chart) {
  const S = 1200;
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');

  // Outer white frame, then draw the chart into a centered "safe area" so the
  // Lab's imperfect phone alignment (small rotation, registration shift, edge
  // crop) can't clip the fiducials. The scale is UNIFORM, so every fiducial /
  // strip / patch keeps its relative position and fiducial-based extraction
  // (CHART_GEOM + homography) is unaffected.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, S, S);
  const safe = 0.74; // chart occupies 74% of the frame, centered
  ctx.save();
  ctx.translate((S * (1 - safe)) / 2, (S * (1 - safe)) / 2);
  ctx.scale(safe, safe);

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, S, S);

  const margin = 70;
  const fid = 56;
  ctx.fillStyle = '#000';
  for (const [x, y] of [
    [margin, margin],
    [S - margin - fid, margin],
    [margin, S - margin - fid],
    [S - margin - fid, S - margin - fid],
  ]) {
    ctx.fillRect(x, y, fid, fid);
  }

  // Gray reference strips: black / 18% gray (sRGB ~0.466) / white
  const stripY = [margin + fid + 18, S - margin - fid - 18 - 50];
  const stripX = margin + fid + 18;
  const stripW = S - 2 * stripX;
  const refGrays = ['#000000', '#777777', '#ffffff'];
  for (const y of stripY) {
    refGrays.forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.fillRect(stripX + (stripW / 3) * i, y, stripW / 3, 50);
    });
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.strokeRect(stripX, y, stripW, 50);
  }

  // 7x7 patch grid between the strips
  const gridTop = stripY[0] + 50 + 18;
  const gridBottom = stripY[1] - 18;
  const gridLeft = margin;
  const gridSize = Math.min(S - 2 * margin, gridBottom - gridTop);
  const cell = gridSize / 7;
  const gap = 6;

  chart.patches.forEach(([r, g, b], i) => {
    const col = i % 7;
    const row = (i / 7) | 0;
    ctx.fillStyle = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
    ctx.fillRect(
      gridLeft + col * cell + gap / 2,
      gridTop + row * cell + gap / 2,
      cell - gap,
      cell - gap,
    );
  });

  ctx.fillStyle = '#000';
  ctx.font = '22px sans-serif';
  ctx.fillText(`${APP_NAME} v${APP_VERSION} — calibration chart ${chart.id}`, margin, S - 28);

  ctx.restore();
}

/* =====================================================================
   Additional refinement test charts. These are printed full-size (not
   from the app UI). Patch charts keep the same safe-area + fiducial +
   reference-strip layout as the calibration charts; the vignette field
   deliberately fills the WHOLE frame so corner falloff can be measured.
   ===================================================================== */

/* General cols×rows patch chart in the safe area (for the dense colour cube,
   the extreme-tone chart, and the repeatability chart). */
function drawGridChart(canvas, chart) {
  const S = 1200, margin = 70, fid = 56;
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, S, S);
  const safe = 0.74;
  ctx.save();
  ctx.translate((S * (1 - safe)) / 2, (S * (1 - safe)) / 2);
  ctx.scale(safe, safe);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, S, S);

  ctx.fillStyle = '#000';
  for (const [x, y] of [
    [margin, margin], [S - margin - fid, margin],
    [margin, S - margin - fid], [S - margin - fid, S - margin - fid],
  ]) ctx.fillRect(x, y, fid, fid);

  const stripY = [margin + fid + 18, S - margin - fid - 18 - 50];
  const stripX = margin + fid + 18;
  const stripW = S - 2 * stripX;
  for (const y of stripY) {
    ['#000000', '#777777', '#ffffff'].forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(stripX + (stripW / 3) * i, y, stripW / 3, 50);
    });
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.strokeRect(stripX, y, stripW, 50);
  }

  const { cols, rows } = chart;
  const gridTop = stripY[0] + 50 + 18;
  const gridBottom = stripY[1] - 18;
  const gridW = S - 2 * margin;
  const gridH = gridBottom - gridTop;
  const cell = Math.min(gridW / cols, gridH / rows);
  const startX = margin + (gridW - cols * cell) / 2;
  const startY = gridTop + (gridH - rows * cell) / 2;
  const gap = Math.max(3, cell * 0.08);
  chart.patches.forEach(([r, g, b], i) => {
    const col = i % cols, row = (i / cols) | 0;
    ctx.fillStyle = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
    ctx.fillRect(startX + col * cell + gap / 2, startY + row * cell + gap / 2, cell - gap, cell - gap);
  });

  ctx.fillStyle = '#000';
  ctx.font = '20px sans-serif';
  ctx.fillText(`${APP_NAME} v${APP_VERSION} — ${chart.id} (${chart.patches.length} patches)`, margin, S - 28);

  ctx.restore();
}

/* Full-frame uniform field for measuring lens vignetting. No safe area — fills
   edge to edge so the falloff into the corners is measurable. Only tiny corner
   fiducials for registration. */
function drawFlatField(canvas, chart) {
  const S = 1200;
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');

  const v = Math.round(chart.level * 255);
  ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
  ctx.fillRect(0, 0, S, S);

  const fid = 36, pad = 8;
  ctx.fillStyle = '#000';
  for (const [x, y] of [
    [pad, pad], [S - pad - fid, pad],
    [pad, S - pad - fid], [S - pad - fid, S - pad - fid],
  ]) ctx.fillRect(x, y, fid, fid);

  ctx.fillStyle = v > 128 ? '#000' : '#fff';
  ctx.font = '20px sans-serif';
  ctx.fillText(`${APP_NAME} v${APP_VERSION} — ${chart.id} (fills frame; measures corner falloff)`, pad + fid + 12, pad + 26);
}

const TEST_CHARTS = (() => {
  // 6x6x6 RGB cube, split across two printable charts (108 patches each)
  const cube = [];
  const levels = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
  for (const r of levels) for (const g of levels) for (const b of levels) cube.push([r, g, b]);

  // extreme-tone: dense in the deep shadows and bright highlights
  const ext = [];
  for (let i = 0; i <= 10; i++) ext.push([i * 0.02, i * 0.02, i * 0.02]);       // 0.00–0.20 grays
  for (let i = 0; i <= 10; i++) { const v = 0.8 + i * 0.02; ext.push([v, v, v]); } // 0.80–1.00 grays
  ext.push([0.3, 0.3, 0.3], [0.5, 0.5, 0.5], [0.7, 0.7, 0.7]);
  for (const v of [0.05, 0.1, 0.15]) ext.push([v, 0, 0], [0, v, 0], [0, 0, v]);  // deep primaries
  for (const v of [0.1, 0.15]) ext.push([v, v, 0], [0, v, v], [v, 0, v]);        // deep secondaries
  ext.push([1, 0.9, 0.9], [0.9, 1, 0.9], [0.9, 0.9, 1]);                          // pale highlight tints
  ext.push([0.95, 0, 0], [0, 0.95, 0], [0, 0, 0.95]);                             // bright primaries
  ext.push([0.2, 0.13, 0.10], [0.94, 0.78, 0.67], [0.45, 0.30, 0.22]);           // shadow + skins

  // repeatability: a few large, easy-to-read patches (print this one 3–5×)
  const rep = [
    [0, 0, 0], [0.25, 0.25, 0.25], [0.466, 0.466, 0.466], [0.5, 0.5, 0.5], [0.75, 0.75, 0.75], [1, 1, 1],
    [0.9, 0, 0], [0, 0.7, 0], [0, 0, 0.9], [0, 0.8, 0.8], [0.9, 0, 0.9], [0.9, 0.9, 0],
    [0.94, 0.78, 0.67], [0.47, 0.65, 0.85], [0.30, 0.45, 0.22], [0.76, 0.65, 0.45],
  ];

  return {
    cube1: { id: 'color-cube-1', file: 'test-color-cube-1.png', cols: 12, rows: 9, patches: cube.slice(0, 108) },
    cube2: { id: 'color-cube-2', file: 'test-color-cube-2.png', cols: 12, rows: 9, patches: cube.slice(108) },
    extreme: { id: 'extreme-tone', file: 'test-extreme-tone.png', cols: 7, rows: 7, patches: ext },
    repeat: { id: 'repeatability', file: 'test-repeatability.png', cols: 4, rows: 4, patches: rep },
    vignette: { id: 'vignette-field', file: 'test-vignette-field.png', level: 0x77 / 255 },
  };
})();
