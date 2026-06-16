/* UI wiring: image loading, slider state, preview rendering, exports. */

(() => {
  const PREVIEW_MAX = 640;   // px, longest side of each preview canvas
  const EXPORT_MAX = 3000;   // px, cap for the corrected full-res export

  const NEUTRAL = { exposure: 0, shadowLift: 0, highlightComp: 0, contrast: 0, saturation: 1, temp: 0, tint: 0 };

  const state = {
    params: { ...DEFAULT_PROFILE },
    filmType: 'color',      // 'color' | 'bw'
    measuredColor: null,    // loaded color calibration model, if any
    measuredBW: null,       // loaded B&W calibration model, if any
    useMeasured: false,
    unlockManual: false,    // let sliders ride on top of the measured calibration
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
  const slidersLive = () => !measuredActive() || state.unlockManual;

  // correction fn (r,g,b)->[r,g,b]. Color and B&W measured models share the
  // same `.correct` interface (B&W just returns grayscale).
  //  - heuristic mode: the sliders ARE the pre-compensation.
  //  - measured mode: the calibration pre-distorts for the film. With manual
  //    unlock on, the sliders first grade the image to the look you want, then
  //    the measured layer pre-distorts that — so the print lands on your look.
  const currentCorrection = () => {
    const m = activeMeasured();
    if (!m) return makeCorrection(state.params, state.filmType);
    if (!state.unlockManual) return m.correct;
    const grade = makeCorrection(state.params, state.filmType);
    return (r, g, b) => m.correct(...grade(r, g, b));
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

  document.getElementById('btn-reset').addEventListener('click', () => setParams(DEFAULT_PROFILE));
  document.getElementById('btn-zero').addEventListener('click', () => setParams(NEUTRAL));

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
      syncMeasuredUI();
      refreshPreviews();
    });
  }

  // --- Lab exposure (predicted-print simulation) ---------------------------

  const labExpoEl = document.getElementById('lab-expo');
  const labExpoVal = document.getElementById('lab-expo-val');
  labExpoEl.addEventListener('input', () => {
    state.labExposure = Number(labExpoEl.value);
    labExpoVal.textContent = (state.labExposure >= 0 ? '+' : '') + state.labExposure.toFixed(1);
    refreshPreviews();
  });

  // --- Measured calibration ------------------------------------------------

  const useMeasuredEl = document.getElementById('use-measured');
  const unlockEl = document.getElementById('unlock-manual');
  const footerNote = document.getElementById('footer-note');
  const heuristicNote = footerNote.textContent;
  const calibMetaText = { color: '', bw: '' };

  function hasCalibration(filmType) {
    return !!(filmType === 'bw' ? state.measuredBW : state.measuredColor);
  }

  function syncMeasuredUI() {
    const has = hasCalibration(state.filmType);
    useMeasuredEl.disabled = !has;
    if (!has && state.useMeasured) {
      state.useMeasured = false;
      useMeasuredEl.checked = false;
    }
    unlockEl.disabled = !measuredActive();
    updateSliderEnabled();

    document.getElementById('calib-meta').textContent = has
      ? `${state.filmType === 'bw' ? 'B&W' : 'Color'}: ${calibMetaText[state.filmType]}`
      : `No measured calibration for ${state.filmType === 'bw' ? 'B&W' : 'color'} yet — print and scan its chart to build one.`;

    footerNote.textContent = measuredActive()
      ? (state.unlockManual
          ? 'Measured calibration with manual tweaks on top: the sliders grade your image, then your film’s measured response pre-distorts it so the print lands on that look.'
          : state.filmType === 'bw'
            ? 'Preview driven by your measured B&W film response (tone curve + spectral weights). Deep shadows below the film’s floor can’t be recovered.'
            : 'Preview driven by your measured color film response (per-channel). Saturated colors are approximate until a denser calibration. Deep shadows below the film’s floor can’t be recovered.')
      : heuristicNote;
  }

  useMeasuredEl.addEventListener('change', () => {
    state.useMeasured = useMeasuredEl.checked;
    syncMeasuredUI();
    refreshPreviews();
  });

  unlockEl.addEventListener('change', () => {
    state.unlockManual = unlockEl.checked;
    // start tweaks from neutral so enabling them doesn't change the measured result
    if (state.unlockManual) setParams(NEUTRAL);
    syncMeasuredUI();
    refreshPreviews();
  });

  function loadCalib(url, type, builder) {
    return fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((calib) => {
        if (!calib) return;
        if (type === 'bw') state.measuredBW = builder(calib);
        else state.measuredColor = builder(calib);
        const m = calib.meta || {};
        calibMetaText[type] = `fitted from ${m.samples || '?'} patches (${m.source || 'scans'}, ${m.date || ''}).`;
        document.getElementById('calib-panel').hidden = false;
        syncMeasuredUI();
      })
      .catch(() => {});
  }
  loadCalib('charts/calibration-color.json', 'color', loadCalibration);
  loadCalib('charts/calibration-bw.json', 'bw', loadBWCalibration);

  // --- Image loading -------------------------------------------------------

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
  });

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

  exportImageBtn.addEventListener('click', () => {
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

    canvas.toBlob(
      (blob) => download(blob, `${state.fileName}_polaroid-ready_v${APP_VERSION}.png`),
      'image/png',
    );
  });

  document.getElementById('btn-export-cube').addEventListener('click', () => {
    const tag = measuredActive() ? `measured-${state.filmType}` : state.filmType;
    const cube = lutToCube(
      buildLut(currentCorrection()),
      `${APP_NAME} v${APP_VERSION} — ${measuredActive() ? 'measured' : 'pre-compensation'} (${tag})`,
    );
    download(cube, `polaroid-lab-${measuredActive() ? 'measured' : 'precomp'}-${tag}-v${APP_VERSION}.cube`, 'text/plain');
  });

  for (const [btnId, chart] of [
    ['btn-export-chart-color', COLOR_CHART],
    ['btn-export-chart-color2', COLOR_CHART_2],
    ['btn-export-chart-bw', BW_CHART],
  ]) {
    document.getElementById(btnId).addEventListener('click', () => {
      const canvas = document.createElement('canvas');
      drawChart(canvas, chart);
      const file = chart.file.replace(/\.png$/, `-v${APP_VERSION}.png`);
      canvas.toBlob((blob) => download(blob, file), 'image/png');
    });
  }

  document.getElementById('app-version').textContent = 'v' + APP_VERSION;
})();
