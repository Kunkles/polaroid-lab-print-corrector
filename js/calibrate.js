/* Phase 2 calibration: read a scanned/photographed chart print and extract
   measured (input -> printed) color pairs.

   Pipeline:
   1. detectFiducials  — find the 4 black corner squares in the capture
   2. solveHomography  — map known chart-design coords onto the capture
   3. extractChart     — median-sample the reference strips and the patches
   4. normalize        — use each chart's own strips to undo the per-frame
                         exposure/white-balance the Lab's AE + the scanner
                         applied, bringing every chart into a common space

   Geometry constants below MUST match drawChart() in chart.js (S = 1200). */

const CHART_GEOM = (() => {
  const S = 1200, margin = 70, fid = 56;
  const half = fid / 2;
  const fiducials = {
    TL: [margin + half, margin + half],
    TR: [S - margin - half, margin + half],
    BL: [margin + half, S - margin - half],
    BR: [S - margin - half, S - margin - half],
  };

  const stripY = [margin + fid + 18, S - margin - fid - 18 - 50];
  const stripH = 50;
  const stripX = margin + fid + 18;
  const stripW = S - 2 * stripX;
  // black / 18% gray / white thirds; known sRGB values printed on the chart
  const stripRef = [0.0, 0x77 / 255, 1.0];
  const stripCenters = (y) =>
    [0, 1, 2].map((i) => [stripX + stripW / 3 * (i + 0.5), y + stripH / 2]);
  const strips = {
    top: stripCenters(stripY[0]),
    bottom: stripCenters(stripY[1]),
    ref: stripRef,
  };

  const gridTop = stripY[0] + stripH + 18;
  const gridBottom = stripY[1] - 18;
  const gridLeft = margin;
  const gridSize = Math.min(S - 2 * margin, gridBottom - gridTop);
  const cell = gridSize / 7;
  const patchCenter = (i) => {
    const col = i % 7, row = (i / 7) | 0;
    return [gridLeft + (col + 0.5) * cell, gridTop + (row + 0.5) * cell];
  };

  return { S, fiducials, strips, patchCenter, cell };
})();

// --- capture loading --------------------------------------------------------

function loadImageData(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, img.width, img.height));
    };
    img.onerror = reject;
    img.src = url;
  });
}

function lum(d, i) {
  return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
}

// --- fiducial detection -----------------------------------------------------

/* Connected dark blobs, filtered to solid squares, then the one nearest each
   image corner is taken as that corner's fiducial. */
function detectFiducials(im) {
  const { width: w, height: h, data: d } = im;

  // adaptive dark threshold from the luminance distribution
  const sample = [];
  for (let i = 0; i < d.length; i += 4 * 37) sample.push(lum(d, i));
  sample.sort((a, b) => a - b);
  const white = sample[(sample.length * 0.9) | 0];
  const thresh = white * 0.4;

  const label = new Int32Array(w * h).fill(-1);
  const blobs = [];
  const stack = [];

  for (let p = 0; p < w * h; p++) {
    if (label[p] !== -1 || lum(d, p * 4) >= thresh) continue;
    const id = blobs.length;
    let area = 0, sx = 0, sy = 0, minX = w, minY = h, maxX = 0, maxY = 0;
    stack.push(p);
    label[p] = id;
    while (stack.length) {
      const q = stack.pop();
      const qx = q % w, qy = (q / w) | 0;
      area++; sx += qx; sy += qy;
      if (qx < minX) minX = qx; if (qx > maxX) maxX = qx;
      if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
      const nb = [q - 1, q + 1, q - w, q + w];
      for (const r of nb) {
        if (r < 0 || r >= w * h) continue;
        if (r % w === w - 1 && q % w === 0) continue;
        if (r % w === 0 && q % w === w - 1) continue;
        if (label[r] === -1 && lum(d, r * 4) < thresh) {
          label[r] = id;
          stack.push(r);
        }
      }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    blobs.push({
      area, cx: sx / area, cy: sy / area,
      bw, bh, fill: area / (bw * bh), aspect: bw / bh,
    });
  }

  // fiducials are solid (~filled) and roughly square
  const candidates = blobs.filter(
    (b) => b.area > 60 && b.fill > 0.6 && b.aspect > 0.5 && b.aspect < 2.0
  );
  if (candidates.length < 4) throw new Error(`only ${candidates.length} fiducial candidates`);

  const corners = { TL: [0, 0], TR: [w, 0], BL: [0, h], BR: [w, h] };
  const out = {};
  for (const key of ['TL', 'TR', 'BL', 'BR']) {
    const [cx, cy] = corners[key];
    let best = null, bestD = Infinity;
    for (const b of candidates) {
      const dd = (b.cx - cx) ** 2 + (b.cy - cy) ** 2;
      if (dd < bestD) { bestD = dd; best = b; }
    }
    out[key] = [best.cx, best.cy];
  }
  return out;
}

// --- homography (design -> capture) -----------------------------------------

function solveHomography(src, dst) {
  // src/dst: arrays of 4 [x,y]; returns 3x3 H mapping src -> dst
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
  }
  const hh = gauss(A, b); // 8 unknowns
  return [hh[0], hh[1], hh[2], hh[3], hh[4], hh[5], hh[6], hh[7], 1];
}

function gauss(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const pivVal = M[c][c];
    for (let k = c; k <= n; k++) M[c][k] /= pivVal;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row[n]);
}

function applyH(H, [x, y]) {
  const d = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
}

// --- sampling ---------------------------------------------------------------

/* Median RGB (0..1) in a square window — robust to dust, edges, JPEG noise. */
function sampleMedian(im, cx, cy, r) {
  const { width: w, height: h, data: d } = im;
  const ch = [[], [], []];
  const x0 = Math.max(0, (cx - r) | 0), x1 = Math.min(w - 1, (cx + r) | 0);
  const y0 = Math.max(0, (cy - r) | 0), y1 = Math.min(h - 1, (cy + r) | 0);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4;
      ch[0].push(d[i]); ch[1].push(d[i + 1]); ch[2].push(d[i + 2]);
    }
  return ch.map((a) => {
    a.sort((p, q) => p - q);
    return a[a.length >> 1] / 255;
  });
}

// --- extraction -------------------------------------------------------------

function extractChart(im) {
  const fids = detectFiducials(im);
  const G = CHART_GEOM;
  const H = solveHomography(
    [G.fiducials.TL, G.fiducials.TR, G.fiducials.BL, G.fiducials.BR],
    [fids.TL, fids.TR, fids.BL, fids.BR]
  );

  // window sizes scaled to the captured chart size
  const captW = Math.hypot(fids.TR[0] - fids.TL[0], fids.TR[1] - fids.TL[1]);
  const scale = captW / (G.fiducials.TR[0] - G.fiducials.TL[0]);
  const patchR = Math.max(3, (G.cell * 0.3 * scale) | 0);
  const stripR = Math.max(3, (12 * scale) | 0);

  const sampleAt = (pt, r) => sampleMedian(im, ...applyH(H, pt), r);

  const strips = {
    top: G.strips.top.map((pt) => sampleAt(pt, stripR)),
    bottom: G.strips.bottom.map((pt) => sampleAt(pt, stripR)),
    ref: G.strips.ref,
  };
  const patches = [];
  for (let i = 0; i < 49; i++) patches.push(sampleAt(G.patchCenter(i), patchR));

  return { fids, strips, patches };
}

/* Patch centers (design coords, S=1200) for a cols×rows grid chart, matching
   drawGridChart() in chart.js so the cube / refinement charts can be sampled. */
function gridPatchCenters(cols, rows, n) {
  const S = 1200, margin = 70, fid = 56;
  const stripTopY = margin + fid + 18;           // same strips as CHART_GEOM
  const stripBottomY = S - margin - fid - 18 - 50;
  const gridTop = stripTopY + 50 + 18;
  const gridBottom = stripBottomY - 18;
  const gridW = S - 2 * margin;
  const gridH = gridBottom - gridTop;
  const cell = Math.min(gridW / cols, gridH / rows);
  const startX = margin + (gridW - cols * cell) / 2;
  const startY = gridTop + (gridH - rows * cell) / 2;
  const centers = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols, row = (i / cols) | 0;
    centers.push([startX + (col + 0.5) * cell, startY + (row + 0.5) * cell]);
  }
  return { centers, cell };
}

/* Like extractChart, but for a cols×rows grid chart (drawGridChart layout).
   Fiducials and reference strips are in the same place as the calibration
   chart, so detection + normalization are identical; only the patch grid
   differs. Returns the homography + centers too, for overlay drawing. */
function extractGridChart(im, cols, rows, n) {
  const fids = detectFiducials(im);
  const G = CHART_GEOM;
  const H = solveHomography(
    [G.fiducials.TL, G.fiducials.TR, G.fiducials.BL, G.fiducials.BR],
    [fids.TL, fids.TR, fids.BL, fids.BR]
  );

  const captW = Math.hypot(fids.TR[0] - fids.TL[0], fids.TR[1] - fids.TL[1]);
  const scale = captW / (G.fiducials.TR[0] - G.fiducials.TL[0]);
  const { centers, cell } = gridPatchCenters(cols, rows, n);
  const patchR = Math.max(2, (cell * 0.3 * scale) | 0);
  const stripR = Math.max(3, (12 * scale) | 0);
  const sampleAt = (pt, r) => sampleMedian(im, ...applyH(H, pt), r);

  const strips = {
    top: G.strips.top.map((pt) => sampleAt(pt, stripR)),
    bottom: G.strips.bottom.map((pt) => sampleAt(pt, stripR)),
    ref: G.strips.ref,
  };
  const patches = centers.map((pt) => sampleAt(pt, patchR));
  return { fids, H, strips, patches, centers };
}

// --- orientation ------------------------------------------------------------

/* Rotate ImageData by 0/90/180/270°. Charts are square with four identical
   corner fiducials, so orientation can't be read from the fiducials — a chart
   scanned sideways still detects 4 corners but maps the patches wrong. */
function rotateImageData(im, deg) {
  if (deg % 360 === 0) return im;
  const src = document.createElement('canvas');
  src.width = im.width; src.height = im.height;
  src.getContext('2d').putImageData(im, 0, 0);
  const swap = deg % 180 !== 0;
  const c = document.createElement('canvas');
  c.width = swap ? im.height : im.width;
  c.height = swap ? im.width : im.height;
  const x = c.getContext('2d');
  x.translate(c.width / 2, c.height / 2);
  x.rotate((deg * Math.PI) / 180);
  x.drawImage(src, -im.width / 2, -im.height / 2);
  return x.getImageData(0, 0, c.width, c.height);
}

/* Extract a chart at whichever of the 4 orientations is correct. The reference
   strips (black/gray/white) only read with full black→white separation when the
   chart is upright, so the orientation with the largest separation wins. Works
   for any chart type (all share the same strips). Returns { ex, im, deg }. */
function extractOriented(im, extractFn) {
  let best = null;
  for (const deg of [0, 90, 180, 270]) {
    try {
      const rim = rotateImageData(im, deg);
      const ex = extractFn(rim);
      const r = stripResponse(ex.strips);
      const sep = (r.white[0] + r.white[1] + r.white[2] - r.black[0] - r.black[1] - r.black[2]) / 3;
      if (!best || sep > best.sep) best = { sep, ex, im: rim, deg };
    } catch (e) { /* fiducials not found at this rotation — skip */ }
  }
  if (!best) throw new Error('only 0 fiducial candidates'); // matches detectFiducials phrasing
  return best;
}

// --- normalization ----------------------------------------------------------

/* Build a per-channel response from the chart's own strips (averaging the top
   and bottom strip to cancel vertical vignetting), then invert it so the
   measured patches are expressed as if captured through a neutral, linear
   device. This is what removes the per-frame AE/scanner differences. */
function stripResponse(strips) {
  const avg = strips.top.map((t, i) => t.map((v, c) => (v + strips.bottom[i][c]) / 2));
  // avg[0]=black, avg[1]=gray, avg[2]=white patches as captured (0..1)
  return { black: avg[0], gray: avg[1], white: avg[2], ref: strips.ref };
}

/* Map a captured color back toward scene-referred using the strip anchors:
   per channel, a piecewise-linear curve through (captured -> known) at the
   three reference levels. */
function normalizeColor(rgb, resp) {
  const anchors = (c) => [
    [resp.black[c], resp.ref[0]],
    [resp.gray[c], resp.ref[1]],
    [resp.white[c], resp.ref[2]],
  ].sort((a, b) => a[0] - b[0]);
  return rgb.map((v, c) => {
    const a = anchors(c);
    if (v <= a[0][0]) return a[0][1];
    if (v >= a[2][0]) return a[2][1];
    const seg = v <= a[1][0] ? [a[0], a[1]] : [a[1], a[2]];
    const t = (v - seg[0][0]) / (seg[1][0] - seg[0][0] || 1);
    return seg[0][1] + t * (seg[1][1] - seg[0][1]);
  });
}
