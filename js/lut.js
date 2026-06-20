/* 3D LUT construction, application, and .cube export.
   LUTs are stored as Float32Array in .cube order: red varies fastest, then green, then blue. */

const LUT_SIZE = 33;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/* Build a LUT by sampling fn(r, g, b) -> [r, g, b], all components in 0..1. */
function buildLut(fn, size = LUT_SIZE) {
  const data = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = fn(r / (size - 1), g / (size - 1), b / (size - 1));
        data[i++] = clamp01(out[0]);
        data[i++] = clamp01(out[1]);
        data[i++] = clamp01(out[2]);
      }
    }
  }
  return { size, data };
}

/* Apply a LUT to ImageData in place, with trilinear interpolation. */
function applyLut(imageData, lut) {
  const { size: n, data: t } = lut;
  const d = imageData.data;
  const max = n - 1;
  const scale = max / 255;

  for (let i = 0; i < d.length; i += 4) {
    const fr = d[i] * scale;
    const fg = d[i + 1] * scale;
    const fb = d[i + 2] * scale;

    const r0 = Math.min(fr | 0, max - 1);
    const g0 = Math.min(fg | 0, max - 1);
    const b0 = Math.min(fb | 0, max - 1);
    const tr = fr - r0;
    const tg = fg - g0;
    const tb = fb - b0;

    const i000 = 3 * (r0 + n * (g0 + n * b0));
    const i100 = i000 + 3;
    const i010 = i000 + 3 * n;
    const i110 = i010 + 3;
    const i001 = i000 + 3 * n * n;
    const i101 = i001 + 3;
    const i011 = i001 + 3 * n;
    const i111 = i011 + 3;

    for (let c = 0; c < 3; c++) {
      const c00 = t[i000 + c] + (t[i100 + c] - t[i000 + c]) * tr;
      const c10 = t[i010 + c] + (t[i110 + c] - t[i010 + c]) * tr;
      const c01 = t[i001 + c] + (t[i101 + c] - t[i001 + c]) * tr;
      const c11 = t[i011 + c] + (t[i111 + c] - t[i011 + c]) * tr;
      const c0 = c00 + (c10 - c00) * tg;
      const c1 = c01 + (c11 - c01) * tg;
      d[i + c] = (c0 + (c1 - c0) * tb) * 255 + 0.5;
    }
  }
}

/* Serialize a LUT to the Adobe .cube text format. */
function lutToCube(lut, title) {
  const lines = [
    `TITLE "${title}"`,
    `LUT_3D_SIZE ${lut.size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
  ];
  const t = lut.data;
  for (let i = 0; i < t.length; i += 3) {
    lines.push(`${t[i].toFixed(6)} ${t[i + 1].toFixed(6)} ${t[i + 2].toFixed(6)}`);
  }
  return lines.join('\n') + '\n';
}

/* Parse an Adobe .cube 3D LUT into { size, data } (red varies fastest). */
function cubeToLut(text) {
  let size = 0;
  const data = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^LUT_3D_SIZE\s+(\d+)/i);
    if (m) { size = +m[1]; continue; }
    if (/^LUT_1D_SIZE/i.test(line)) throw new Error('1D LUTs are not supported');
    if (/^(TITLE|DOMAIN_|LUT_)/i.test(line)) continue;
    const p = line.split(/\s+/).map(Number);
    if (p.length >= 3 && p.slice(0, 3).every((v) => !Number.isNaN(v))) data.push(p[0], p[1], p[2]);
  }
  if (!size || data.length !== size * size * size * 3) {
    throw new Error('not a valid 3D .cube file');
  }
  return { size, data: Float32Array.from(data) };
}

/* Trilinearly sample a LUT at a single (r, g, b) in 0..1; returns [r, g, b]. */
function sampleLut(lut, r, g, b) {
  const { size: n, data: t } = lut;
  const max = n - 1;
  const fr = clamp01(r) * max, fg = clamp01(g) * max, fb = clamp01(b) * max;
  const r0 = Math.min(fr | 0, max - 1), g0 = Math.min(fg | 0, max - 1), b0 = Math.min(fb | 0, max - 1);
  const tr = fr - r0, tg = fg - g0, tb = fb - b0;
  const i000 = 3 * (r0 + n * (g0 + n * b0));
  const i100 = i000 + 3, i010 = i000 + 3 * n, i110 = i010 + 3;
  const i001 = i000 + 3 * n * n, i101 = i001 + 3, i011 = i001 + 3 * n, i111 = i011 + 3;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = t[i000 + c] + (t[i100 + c] - t[i000 + c]) * tr;
    const c10 = t[i010 + c] + (t[i110 + c] - t[i010 + c]) * tr;
    const c01 = t[i001 + c] + (t[i101 + c] - t[i001 + c]) * tr;
    const c11 = t[i011 + c] + (t[i111 + c] - t[i011 + c]) * tr;
    const c0 = c00 + (c10 - c00) * tg;
    const c1 = c01 + (c11 - c01) * tg;
    out[c] = c0 + (c1 - c0) * tb;
  }
  return out;
}
