# Polaroid Lab Print Corrector

A small, dependency-free web app that **pre-compensates digital photos so they print correctly on the [Polaroid Lab](https://www.polaroid.com/en_us/products/polaroid-lab)** instant printer. If your Polaroid Lab prints come out with **crushed shadows, a muddy green/warm color cast, blown highlights, or just look too dark**, this tool distorts the image in the opposite direction of what the film does — so the print lands where you want it.

It works for **i-Type / 600 instant film** (color and black & white), and it can either export a corrected image to print from your phone, or a `.cube` 3D LUT you can apply in Lightroom / Capture One / Photoshop.

> **TL;DR** — Instant film has ~5 stops of latitude against a phone photo's 12+. The Lab crushes the bottom third of your tones to black and adds a cast. This app measures exactly how *your* Lab + film behaves (from a printed test chart) and inverts it.

---

## The problem

The Polaroid Lab is great, but:

- **Narrow dynamic range.** Anything below ~⅓ of your tonal range prints as featureless near-black. On a real photo that's usually the whole lower two-thirds of the frame.
- **Color cast.** Blacks come out muddy and cool/green; whites come out cream; the red channel dies first in shadows.
- **An auto-exposure you can't fully predict.** The Lab meters the whole frame and sets one global exposure — and it's the single biggest factor in how a print turns out.

The first two are *deterministic* (fixed by the film's chemistry and the Lab's optics) and this app corrects them. The third is *stochastic* and is handled with exposure compensation, not the correction — see [Auto-exposure: the honest limitation](#auto-exposure-the-honest-limitation).

## What it does

- **Pre-compensation correction** — lifts shadows into the film's responsive band, tames highlights, and counters the per-channel color cast.
- **Predicted-print preview** — shows a realistic simulation of what the untouched photo *and* the corrected photo will look like once printed, so you can judge before spending film.
- **Measured calibration** — print a test chart, scan it, and the app fits the **actual** transfer function of your specific Lab + film batch and inverts it into a correction tuned to your hardware.
- **Lab-exposure simulation** — a slider that models the auto-exposure in the preview panels, so you can see how the print changes with exposure compensation.
- **Exports** — a print-ready PNG (AirDrop to your phone, print with the Polaroid app) or a 33³ `.cube` 3D LUT for your normal editing software.

## Quick start

No build step, no dependencies. Either:

```sh
# just open it
open index.html
```

or serve it (needed if you want to load the calibration JSON over http):

```sh
node serve.js          # http://localhost:8741
# or: python3 -m http.server 8741
```

## Workflow

1. Drop a photo in.
2. Four panels show: **Original**, **Corrected — print this**, **Predicted print of original**, **Predicted print of corrected**.
3. Adjust the sliders if a shot needs it (or turn on a measured calibration for device-accurate correction).
4. **Download corrected photo** → send to your phone → print with the Polaroid app. Or **Download .cube LUT** for Lightroom / Capture One / Photoshop.
5. Set the Lab's **exposure compensation** for the shot (bright, shadow-heavy scenes often want +1 to +2 stops — the correction handles tone shape and color, *not* overall brightness).

## How it works

Everything is a 33³ trilinear-interpolated 3D LUT ([js/lut.js](js/lut.js)).

- **Correction** ([js/pipeline.js](js/pipeline.js) → `makeCorrection`): exposure in linear light, black-floor lift, highlight rolloff, contrast, saturation, temp/tint. In B&W mode the output is grayscale and temp/tint act as lens color filters (e.g. amber darkens skies, like a real filter on B&W film).
- **Film simulation** (`filmSim` / `filmSimBW`): a forward model of the Lab + film — steep S-curve (narrow latitude), warm cast, desaturation, muddy warm blacks, cream whites. Replaced by your measured data after calibration.

## Calibrating to your own Lab and film

The heuristic film model becomes a *measured* one in four steps ([js/chart.js](js/chart.js), [js/calibrate.js](js/calibrate.js), [js/solve.js](js/solve.js)):

1. **Print a test chart** through the Lab **with the correction zeroed** (it must measure the raw transfer). The app generates color and B&W charts — 49 patches each (gray ramp, RGB cube, memory colors), with black corner fiducials and black/gray/white reference strips.
2. **Scan or photograph the print.** A flatbed is best (flat, even light); scan with all auto-enhance/auto-color **off**. The corner squares locate the patch grid; the reference strips let the software undo the scanner's white balance and exposure.
3. **Extract** — fiducial detection → perspective correction (homography) → median-sample every patch and strip.
4. **Fit and invert** — fit the film's per-channel forward response (printed = f(input)), force it monotonic, and invert it into a correction that's exact for *your* Lab and film batch. Toggle **Use my measured calibration** to use it; **Unlock manual tweaks** to grade on top.

## Auto-exposure: the honest limitation

The film's distortion splits in two:

- **Deterministic and correctable:** the tone curve (shadow crush, highlight shoulder) and the color cast. This is what the correction fixes, and it works.
- **Stochastic and *not* correctable:** absolute exposure. The Lab's auto-exposure meters each frame globally and sets one exposure — it's content-dependent, varies somewhat frame to frame, and a per-pixel correction can neither predict nor override it.

Practically: **process once for tone and color, then manage brightness with the Lab's exposure-compensation slider** (and, for important shots, print two and keep the better one). Development temperature, immediate light shielding, and film-pack freshness reduce the frame-to-frame variance.

## Project layout

```
index.html        app shell
css/style.css
js/lut.js         3D LUT build / trilinear apply / .cube export
js/pipeline.js    correction transform + heuristic film models (color + B&W)
js/chart.js       calibration chart generator + patch ground truth
js/calibrate.js   read a scanned chart: fiducials, homography, patch sampling
js/solve.js       fit the film's forward response and invert it to a correction
js/app.js         UI wiring, rendering, exports
serve.js          minimal static dev server (Node, no deps)
```

## Versioning

The version lives in one place — [js/version.js](js/version.js) (`APP_VERSION`) — and is shown in the app header, **printed on every calibration chart**, and baked into export filenames and the `.cube` title. Bump it whenever you change something that affects the correction, then note the version on each print so a result can always be traced back to the exact code that made it.

```
PATCH (1.0.x) — tweaks that don't change correction output (UI, docs)
MINOR (1.x.0) — correction / calibration behavior changes
MAJOR (x.0.0) — a new calibration you re-shoot charts for
```

## Status & roadmap

Working: color + B&W correction, predicted-print preview, measured color calibration end-to-end, Lab-exposure simulation.

Next:
- Constant-gray-surround chart to hold the auto-exposure steady across calibration frames.
- 3D scattered-data interpolation for accurate saturated-color correction (the per-channel model handles tone and cast well, vivid colors approximately).
- B&W calibration through the same pipeline.

## License

MIT — see [LICENSE](LICENSE).
