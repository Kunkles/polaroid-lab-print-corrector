/* Color pipeline: the parametric pre-compensation transform and the
   heuristic forward model of Polaroid i-Type/600 film + the Lab's optics.

   Both are pure per-pixel functions on sRGB values in 0..1, so they can be
   baked into 3D LUTs. The film model is intentionally a separate function:
   Phase 2 replaces it with a LUT fitted from real scanned prints, and the
   correction is then solved as its inverse instead of hand-tuned sliders. */

/* Heuristic starting profile, distilled from common Polaroid Lab advice:
   brighten, lift the black floor, soften highlights, drop contrast,
   add saturation the film will eat, cool slightly against the warm cast. */
const DEFAULT_PROFILE = {
  exposure: 0.4,      // stops
  shadowLift: 0.12,   // raises the black floor so shadows don't crush
  highlightComp: 0.12,// pulls whites down so they don't clip to paper white
  contrast: -0.15,
  saturation: 1.15,
  temp: -0.2,         // negative = cooler, counters the film's warm cast
  tint: 0,            // positive = magenta, negative = green
};

const SLIDER_DEFS = [
  { key: 'exposure',      label: 'Exposure (stops)',   min: -1,   max: 1.5, step: 0.05 },
  { key: 'shadowLift',    label: 'Shadow lift',        min: 0,    max: 0.35, step: 0.01 },
  { key: 'highlightComp', label: 'Highlight rolloff',  min: 0,    max: 0.35, step: 0.01 },
  { key: 'contrast',      label: 'Contrast',           min: -0.6, max: 0.6, step: 0.02 },
  { key: 'saturation',    label: 'Saturation',         min: 0.5,  max: 1.8, step: 0.02 },
  { key: 'temp',          label: 'Temp (blue–amber)',  min: -1,   max: 1,   step: 0.02 },
  { key: 'tint',          label: 'Tint (green–magenta)', min: -1, max: 1,   step: 0.02 },
];

function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v) {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* Returns fn(r, g, b) -> [r, g, b] implementing the pre-compensation.
   In 'bw' mode the output is grayscale: temp/tint act as color filters
   (like a red filter in B&W photography) weighting the channels before
   the luminance conversion, and saturation has no effect. */
function makeCorrection(p, filmType = 'color') {
  const gain = Math.pow(2, p.exposure);
  const rGain = 1 + 0.12 * p.temp;
  const bGain = 1 - 0.12 * p.temp;
  const gGain = 1 - 0.10 * p.tint;

  const tone = (v) => {
    v = linearToSrgb(clamp01(srgbToLinear(v) * gain));
    v += p.shadowLift * Math.pow(1 - v, 4);
    v -= p.highlightComp * Math.pow(v, 4);
    v = 0.5 + (v - 0.5) * (1 + p.contrast);
    return clamp01(v);
  };

  if (filmType === 'bw') {
    return (r, g, b) => {
      const l = tone(clamp01(luma(clamp01(r * rGain), clamp01(g * gGain), clamp01(b * bGain))));
      return [l, l, l];
    };
  }

  return (r, g, b) => {
    r = tone(clamp01(r * rGain));
    g = tone(clamp01(g * gGain));
    b = tone(clamp01(b * bGain));
    const l = luma(r, g, b);
    return [
      clamp01(l + (r - l) * p.saturation),
      clamp01(l + (g - l) * p.saturation),
      clamp01(l + (b - l) * p.saturation),
    ];
  };
}

/* Forward model of what the Lab + film do to an sRGB value.
   Tuned by eye against typical i-Type results; Phase 2 replaces this
   with a measured LUT. */
const FILM = {
  slope: 6.5,           // steepness of the film's S-curve (narrow latitude)
  mid: 0.48,            // input level that lands at mid-density
  desat: 0.82,          // film eats ~18% of saturation
  rGain: 1.05,          // warm cast in
  bGain: 0.93,
  black: [0.11, 0.095, 0.10],  // film "black" is a muddy warm dark, not 0
  white: [0.96, 0.93, 0.87],   // film "white" is slightly cream, not 1
};

/* B&W 600 film: also narrow latitude, near-neutral paper tones. The
   spectral weights model panchromatic-ish sensitivity (greens render
   brighter than blues); calibration will measure the real weights. */
const FILM_BW = {
  slope: 6.0,
  mid: 0.48,
  weights: [0.30, 0.50, 0.20],
  black: [0.10, 0.10, 0.10],
  white: [0.95, 0.945, 0.93],
};

/* S-curve normalized so input 0 -> 0 and 1 -> 1 before remapping
   onto the film's actual black/white densities. */
function filmCurve(v, k, m) {
  const s = 1 / (1 + Math.exp(-k * (v - m)));
  const s0 = 1 / (1 + Math.exp(k * m));
  const s1 = 1 / (1 + Math.exp(-k * (1 - m)));
  return (s - s0) / (s1 - s0);
}

function filmSim(r, g, b) {
  r = filmCurve(clamp01(r * FILM.rGain), FILM.slope, FILM.mid);
  g = filmCurve(g, FILM.slope, FILM.mid);
  b = filmCurve(clamp01(b * FILM.bGain), FILM.slope, FILM.mid);

  const l = luma(r, g, b);
  r = l + (r - l) * FILM.desat;
  g = l + (g - l) * FILM.desat;
  b = l + (b - l) * FILM.desat;

  return [
    FILM.black[0] + (FILM.white[0] - FILM.black[0]) * clamp01(r),
    FILM.black[1] + (FILM.white[1] - FILM.black[1]) * clamp01(g),
    FILM.black[2] + (FILM.white[2] - FILM.black[2]) * clamp01(b),
  ];
}

function filmSimBW(r, g, b) {
  const [wr, wg, wb] = FILM_BW.weights;
  const l = filmCurve(clamp01(wr * r + wg * g + wb * b), FILM_BW.slope, FILM_BW.mid);
  return [
    FILM_BW.black[0] + (FILM_BW.white[0] - FILM_BW.black[0]) * l,
    FILM_BW.black[1] + (FILM_BW.white[1] - FILM_BW.black[1]) * l,
    FILM_BW.black[2] + (FILM_BW.white[2] - FILM_BW.black[2]) * l,
  ];
}
