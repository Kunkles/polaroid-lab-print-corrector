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
  ctx.fillText(`AI LUT Matching — calibration chart ${chart.id}`, margin, S - 28);
}
