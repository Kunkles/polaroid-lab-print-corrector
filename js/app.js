/* UI wiring: image loading, slider state, preview rendering, exports. */

(() => {
  const PREVIEW_MAX = 640;   // px, longest side of each preview canvas
  const EXPORT_MAX = 3000;   // px, cap for the corrected full-res export

  const NEUTRAL = { exposure: 0, shadowLift: 0, highlightComp: 0, contrast: 0, saturation: 1, temp: 0, tint: 0 };

  const state = {
    params: { ...NEUTRAL },  // manual tweaks ride on top of the measured calibration
    filmType: 'color',      // 'color' | 'bw'
    measuredColor: null,    // loaded color calibration model, if any
    measuredBW: null,       // loaded B&W calibration model, if any
    useMeasured: true,      // always use the measured calibration when available
    unlockManual: true,     // manual tweak sliders are always live
    strength: 1,            // 0..1 blend between no correction and full correction
    disableCorrection: false, // advanced: bypass correction entirely
    uploadedLut: null,      // advanced: a loaded .cube LUT { size, data }
    uploadedLutName: '',
    labExposure: 0,         // simulated Lab AE exposure (stops), preview only
    fullImage: null,        // HTMLImageElement at native resolution
    fileName: 'photo',
    previewPixels: null,    // ImageData of the downscaled original
    renderQueued: false,
  };

  // the measured model for the current film type, if loaded and enabled
  const activeMeasured = () =>
    state.useMeasured ? (state.filmType === 'bw' ? state.measuredBW : state.measuredColor) : null;
  const measuredActive = () => !!activeMeasured();
  const slidersLive = () =>
    !state.disableCorrection && !state.uploadedLut && (!measuredActive() || state.unlockManual);

  // identifies what produced an export, so prints are traceable
  const correctionMode = () => {
    if (state.disableCorrection) return 'off';
    if (state.uploadedLut) return 'custom-lut';
    const m = activeMeasured();
    const base = m
      ? (m.type === 'color3d' ? 'measured-color3d' : `measured-${state.filmType}`)
      : `heuristic-${state.filmType}`;
    return state.strength >= 0.999 ? base : `${base}-${Math.round(state.strength * 100)}pct`;
  };

  // correction fn (r,g,b)->[r,g,b]. Color and B&W measured models share the
  // same `.correct` interface (B&W just returns grayscale).
  //  - heuristic mode: the sliders ARE the pre-compensation.
  //  - measured mode: the calibration pre-distorts for the film. With manual
  //    unlock on, the sliders first grade the image to the look you want, then
  //    the measured layer pre-distorts that — so the print lands on your look.
  const baseCorrection = () => {
    const m = activeMeasured();
    if (!m) return makeCorrection(state.params, state.filmType);
    if (!state.unlockManual) return m.correct;
    const grade = makeCorrection(state.params, state.filmType);
    return (r, g, b) => m.correct(...grade(r, g, b));
  };

  // Apply the strength blend: lerp between the original (no correction) and the
  // full correction. In B&W the blended result is re-neutralized so it stays
  // grayscale at partial strength.
  const currentCorrection = () => {
    if (state.disableCorrection) return (r, g, b) => [r, g, b];
    if (state.uploadedLut) return (r, g, b) => sampleLut(state.uploadedLut, r, g, b);
    const base = baseCorrection();
    const s = state.strength;
    if (s >= 0.999) return base;
    const bw = state.filmType === 'bw';
    return (r, g, b) => {
      const c = base(r, g, b);
      let o0 = r + (c[0] - r) * s, o1 = g + (c[1] - g) * s, o2 = b + (c[2] - b) * s;
      if (bw) { const y = 0.2126 * o0 + 0.7152 * o1 + 0.0722 * o2; o0 = o1 = o2 = y; }
      return [o0, o1, o2];
    };
  };

  // Simulate the Lab's auto-exposure: shift the scene up/down in linear light
  // before the film transform. Preview-only; the printed file is untouched.
  const labExpose = (v) =>
    state.labExposure === 0 ? v
      : linearToSrgb(clamp01(srgbToLinear(v) * Math.pow(2, state.labExposure)));

  // forward "predicted print" fn. Measured mode renders in real-scan
  // appearance (predictPrintRaw); heuristic film models already look raw.
  const currentFilmSim = () => {
    const m = activeMeasured();
    const film = m ? m.predictPrintRaw : (state.filmType === 'bw' ? filmSimBW : filmSim);
    return (r, g, b) => film(labExpose(r), labExpose(g), labExpose(b));
  };

  const canvases = {
    original: document.getElementById('canvas-original'),
    corrected: document.getElementById('canvas-corrected'),
    simOriginal: document.getElementById('canvas-sim-original'),
    simCorrected: document.getElementById('canvas-sim-corrected'),
  };
  const views = document.getElementById('views');
  const exportImageBtn = document.getElementById('btn-export-image');

  views.classList.add('empty');

  // --- Sliders -------------------------------------------------------------

  const slidersEl = document.getElementById('sliders');
  const sliderInputs = {};

  for (const def of SLIDER_DEFS) {
    const row = document.createElement('div');
    row.className = 'slider-row';

    const label = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = def.label;
    const value = document.createElement('span');
    value.className = 'value';
    label.append(name, value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = def.min;
    input.max = def.max;
    input.step = def.step;
    input.value = state.params[def.key];
    value.textContent = Number(state.params[def.key]).toFixed(2);

    input.addEventListener('input', () => {
      state.params[def.key] = Number(input.value);
      value.textContent = Number(input.value).toFixed(2);
      queueRender();
    });

    sliderInputs[def.key] = { input, value };
    row.append(label, input);
    slidersEl.append(row);
  }

  function setParams(params) {
    state.params = { ...params };
    for (const def of SLIDER_DEFS) {
      sliderInputs[def.key].input.value = params[def.key];
      sliderInputs[def.key].value.textContent = Number(params[def.key]).toFixed(2);
    }
    queueRender();
  }

  document.getElementById('btn-reset').addEventListener('click', () => setParams(NEUTRAL));

  function updateSliderEnabled() {
    const live = slidersLive();
    for (const def of SLIDER_DEFS) {
      const off = !live || (def.key === 'saturation' && state.filmType === 'bw');
      sliderInputs[def.key].input.disabled = off;
    }
  }

  function refreshPreviews() {
    if (!state.previewPixels) return;
    drawWithLut(canvases.simOriginal, buildLut(currentFilmSim()));
    queueRender();
  }

  // --- Film type -----------------------------------------------------------

  for (const radio of document.querySelectorAll('input[name="film-type"]')) {
    radio.addEventListener('change', () => {
      state.filmType = radio.value;
      refreshModeUI();
      refreshPreviews();
    });
  }

  // --- Correction strength -------------------------------------------------

  const strengthEl = document.getElementById('strength');
  const strengthVal = document.getElementById('strength-val');
  strengthEl.addEventListener('input', () => {
    state.strength = Number(strengthEl.value) / 100;
    strengthVal.textContent = `${strengthEl.value}%`;
    document.getElementById('export-mode').textContent = correctionMode();
    queueRender();
  });

  // --- Measured calibration (auto-loaded; always on when available) --------

  const footerNote = document.getElementById('footer-note');
  const heuristicNote = footerNote.textContent;

  function refreshModeUI() {
    updateSliderEnabled();
    document.getElementById('strength').disabled = state.disableCorrection || !!state.uploadedLut;
    document.getElementById('export-mode').textContent = correctionMode();
    footerNote.textContent =
      state.disableCorrection
        ? 'Correction is OFF — previews and exports pass the original through unchanged.'
        : state.uploadedLut
          ? `A custom .cube LUT is driving the correction (${state.uploadedLutName}). It overrides the built-in calibration.`
          : measuredActive()
            ? (state.filmType === 'bw'
                ? 'Driven by the measured B&W film response (tone curve + spectral weights), with your manual tweaks on top. Deep shadows below the film’s floor can’t be recovered.'
                : activeMeasured().type === 'color3d'
                  ? 'Driven by the measured color film response (full 3D LUT from the cube charts), with your manual tweaks on top. Saturated colors are modeled directly; deep shadows below the film’s floor can’t be recovered.'
                  : 'Driven by the measured color film response (per-channel), with your manual tweaks on top. Saturated colors are approximate; deep shadows below the film’s floor can’t be recovered.')
            : heuristicNote;
  }

  function loadCalib(url, type, builder) {
    return fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((calib) => {
        if (!calib) return;
        if (type === 'bw') state.measuredBW = builder(calib);
        else state.measuredColor = builder(calib);
        refreshModeUI();
        refreshPreviews();
      })
      .catch(() => {});
  }
  loadCalib('charts/calibration-color.json', 'color', loadCalibration);
  loadCalib('charts/calibration-bw.json', 'bw', loadBWCalibration);

  refreshModeUI();

  // --- Image loading -------------------------------------------------------

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
  });

  // once a photo is loaded the drop zone is hidden; this re-opens the picker
  document.getElementById('btn-replace').addEventListener('click', () => fileInput.click());

  for (const target of [dropZone, document.body]) {
    target.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    target.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    target.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) loadFile(file);
    });
  }

  function loadFile(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      state.fullImage = img;
      state.fileName = file.name.replace(/\.[^.]+$/, '') || 'photo';

      const scale = Math.min(1, PREVIEW_MAX / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);

      for (const canvas of Object.values(canvases)) {
        canvas.width = w;
        canvas.height = h;
      }

      const ctx = canvases.original.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      state.previewPixels = ctx.getImageData(0, 0, w, h);

      // The film model only changes with the film-type toggle, so the
      // uncorrected-print preview renders outside the slider loop.
      drawWithLut(canvases.simOriginal, buildLut(currentFilmSim()));

      views.classList.remove('empty');
      exportImageBtn.disabled = false;
      queueRender();
    };
    img.onerror = () => alert('Could not load that file as an image.');
    img.src = url;
  }

  // --- Rendering -----------------------------------------------------------

  function drawWithLut(canvas, lut) {
    const copy = new ImageData(
      new Uint8ClampedArray(state.previewPixels.data),
      state.previewPixels.width,
      state.previewPixels.height,
    );
    applyLut(copy, lut);
    canvas.getContext('2d').putImageData(copy, 0, 0);
  }

  function queueRender() {
    if (state.renderQueued || !state.previewPixels) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      const correct = currentCorrection();
      const sim = currentFilmSim();
      drawWithLut(canvases.corrected, buildLut(correct));
      drawWithLut(canvases.simCorrected, buildLut((r, g, b) => sim(...correct(r, g, b))));
    });
  }

  // --- Exports -------------------------------------------------------------

  function download(blobOrText, fileName, type) {
    const blob = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function dataUrlToBlob(dataUrl) {
    const [head, b64] = dataUrl.split(',');
    const mime = head.match(/:(.*?);/)[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  exportImageBtn.addEventListener('click', async () => {
    const img = state.fullImage;
    const scale = Math.min(1, EXPORT_MAX / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyLut(pixels, buildLut(currentCorrection()));
    ctx.putImageData(pixels, 0, 0);

    const fileName = `${state.fileName}_${correctionMode()}_v${APP_VERSION}.png`;
    // Build the blob synchronously so navigator.share() stays inside the click's
    // user-activation window (iOS drops activation across an async toBlob).
    const blob = dataUrlToBlob(canvas.toDataURL('image/png'));
    const file = new File([blob], fileName, { type: 'image/png' });

    // On phones/tablets the share sheet offers "Save Image" → Photos, which is
    // what people want; a plain download lands in Files on iOS. Desktop keeps
    // the direct download.
    const canShareFile = navigator.canShare && navigator.canShare({ files: [file] });
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (canShareFile && touch) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user dismissed the sheet
        // anything else: fall through to a normal download
      }
    }
    download(blob, fileName);
  });

  // --- Calibration: load a calibration built on the calibration page -------

  // load a calibration the user has fit from their own scans
  const calibStatus = document.getElementById('calib-status');
  const calibFileEl = document.getElementById('calib-file');
  document.getElementById('btn-load-calib').addEventListener('click', () => calibFileEl.click());
  calibFileEl.addEventListener('change', () => {
    const file = calibFileEl.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let calib;
      try { calib = JSON.parse(reader.result); } catch { alert('That file is not valid JSON.'); return; }
      const is3d = calib.type === 'color3d';
      const type = calib.type === 'bw' || calib.toneGrid ? 'bw' : 'color';
      try {
        if (type === 'bw') state.measuredBW = loadBWCalibration(calib);
        else if (is3d) state.measuredColor = loadColorCubeCalibration(calib);
        else state.measuredColor = loadCalibration(calib);
      } catch { alert('That JSON does not look like a calibration file.'); return; }
      state.filmType = type;
      document.querySelector(`input[name="film-type"][value="${type}"]`).checked = true;
      calibStatus.textContent = `Loaded ${type === 'bw' ? 'B&W' : is3d ? '3D color' : 'color'} calibration: ${file.name}`;
      refreshModeUI();
      refreshPreviews();
    };
    reader.readAsText(file);
    calibFileEl.value = '';
  });

  document.getElementById('app-version').textContent = 'v' + APP_VERSION;

  // Authorship signature (also see the comment in index.html and the LICENSE).
  console.log(
    `%c${APP_NAME}%c v${APP_VERSION}\n© 2026 ${APP_AUTHOR} · ${APP_REPO}`,
    'font-weight:bold', 'color:inherit',
  );
})();
