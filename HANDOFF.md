# Handoff — Polaroid Lab Print Corrector

A context snapshot for resuming work in a fresh chat. (Author: Ryan Kunkleman.)

## What it is
A dependency-free web app that **pre-compensates digital photos so they print
correctly on the Polaroid Lab** instant printer — counters the film's crushed
shadows, narrow latitude, and color cast for **color (i-Type/600) and B&W**.
Outputs a print-ready PNG (for the phone) or a `.cube` 3D LUT.

- **Live:** https://kunkles.github.io/polaroid-lab-print-corrector/ (GitHub Pages, auto-deploys from `main`)
- **Repo:** https://github.com/Kunkles/polaroid-lab-print-corrector (public, MIT)
- **Stack:** vanilla HTML/CSS/JS, no build. `node serve.js` (port 8741) or just open `index.html`. Version in `js/version.js` (currently **1.2.0**).

## File layout
```
index.html        shell + layout
css/style.css
js/version.js     APP_VERSION / APP_NAME / APP_AUTHOR / APP_REPO
js/lut.js         3D LUT build/apply (trilinear), .cube export (lutToCube) + import (cubeToLut) + sampleLut
js/pipeline.js    makeCorrection (heuristic), filmSim / filmSimBW (forward film model), srgb<->linear, luma
js/chart.js       drawChart (calibration charts) + drawGridChart/drawFlatField (test charts) + chart defs (incl. TEST_CHARTS)
js/calibrate.js   read a scanned chart: detectFiducials (connected components) -> homography -> patch/strip sampling -> strip normalization (rawAnchors / unNormalizeColor)
js/solve.js       fit per-channel forward response -> invert to correction; loadCalibration / loadBWCalibration; solveBWCalibration (tone curve + spectral weights); exportCalibration
js/app.js         all UI wiring
serve.js          tiny Node dev server (also POST /save used by dev tooling)
charts/           LOCAL scans + artifacts (gitignored) EXCEPT calibration-chart-*.png and the two committed anonymized calibrations
test-charts/      committed refinement charts + README
```

## Current behavior
- **Measured calibration is always on** by default. The app auto-loads the two committed, anonymized calibrations (`charts/calibration-color.json`, `charts/calibration-bw.json`). No toggle.
- **Pre-Compensation sliders** are always live as manual tweaks *on top of* the measured correction; they default to **neutral** (no-op until moved).
- **Correction strength** slider (0–100%) blends between the original and the full correction.
- **Film** toggle: color / B&W.
- **Predicted-print preview tiles** are kept (render at neutral exposure). The old "Predicted print" / Lab-exposure slider panel was removed.
- **Advanced panel** ("build your own"): turn off correction; download any chart (3 calibration + 5 refinement test charts); load a calibration `.json`; load a custom `.cube` LUT (overrides correction) or download the current correction as `.cube`.
- **Every export filename is stamped** with the mode + version, e.g. `photo_measured-color_v1.2.0.png`, also `heuristic-bw`, `off`, `custom-lut`, `-70pct`.
- **Layout:** desktop = sticky 4-tile previews on top, Pre-Compensation band, multi-column setup. Mobile order (via `display:contents` + `order`) = **Film, Photo, Previews, Correction strength, Pre-Compensation**, then Export/Advanced.

## Calibration state
- **Color:** per-channel forward model fit from two chart scans (98 patches). Tone + cast solid; **saturated colors are approximate** (per-channel, no crosstalk modeling).
- **B&W:** tone curve + spectral weights — this stock is **blue-sensitive** (R0.29/G0.34/B0.37, far from Rec709). Heuristic still used if no B&W calibration.
- Validated on real single-pass A/B scans: correction lifts crushed shadows and protects highlights; measured renders fuller-range / more photographic than the heuristic.

## The hard limit (important)
The Lab's **auto-exposure** is the dominant, *uncorrectable* factor — it meters each frame globally and sets one exposure, content-dependent and somewhat variable frame-to-frame. A per-pixel correction can't predict or override it. The real lever is the **Lab's exposure-compensation** (≈+1 to +2 stops for bright/shadow-heavy scenes). The correction fixes tone *shape* and color; it does not set exposure.

Other gotchas learned:
- **Scanners auto-expose each scan**, so cross-scan brightness comparisons are invalid — only **single-pass** scans (all prints together) are trustworthy.
- Calibration/test charts use a **74% centered safe area** because the Lab projects the phone onto film and misalignment clips the edges. The **vignette field is the exception** — full-frame, so corner falloff is measurable.
- `predictPrint` is in normalized space; `predictPrintRaw` un-normalizes it for a realistic preview.

## Pending / next steps
1. **Build extractors + solvers for the refinement test charts** (already generated in `test-charts/`, printed with correction OFF, scanned single-pass, auto-color/AE off):
   - **vignette field** → fit a spatial gain map → a new **AE-independent spatial correction layer** (brighten corners). Highest-value, untouched axis.
   - **color cube (1+2)** → 3D scattered-data interpolation to replace the per-channel model (saturated-color accuracy).
   - **extreme-tone** → sharper toe/shoulder.
   - **repeatability** → quantify true frame-to-frame variance.
2. **In-app calibration solver** — currently fitting is done by me via dev/eval scripts. Wire upload-scan → extract → solve → download `.json` into the Advanced panel.
3. Optional: AE characterization via bracketed charts; a constant-gray-surround chart to stabilize the AE during calibration.

## Working notes
- **Never `git add -A`** here — the folder holds personal photos (a leak happened once and was history-scrubbed + force-pushed). Stage explicit paths. `.gitignore` keeps `charts/*` out except `calibration-chart-*.png` + the two calibration JSONs, plus `*.jpg *.tif IMG_* FullSizeRender*`.
- In the headless preview eval, `requestAnimationFrame` doesn't fire, so slider→preview updates don't show there (they work for real users).
- Calibration is built ONLY from chart scans; the photo A/B scans were used for validation only.
