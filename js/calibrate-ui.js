/* Calibration builder UI.

   Reuses the extraction + solver code already loaded on the page:
   - extractChart / stripResponse / normalizeColor          (calibrate.js)
   - detectFiducials / solveHomography / applyH / CHART_GEOM (calibrate.js)
   - solveCorrection / solveBWCalibration / rawAnchors       (solve.js)
   - exportCalibration / exportBWCalibration / grayAvg       (solve.js)
   - COLOR_CHART / COLOR_CHART_2 / BW_CHART                  (chart.js)

   Everything runs in the browser; scans never leave the page. */

(() => {
  document.getElementById('app-version').textContent = 'v' + APP_VERSION;

  const OVERLAY_MAX = 520; // px, longest side of the overlay preview

  // --- file-drop helper ----------------------------------------------------

  /* Wire a .file-drop label (click + drag/drop) to a callback that receives
     the chosen File. Updates the label to show the loaded file name. */
  function wireDrop(id, onFile) {
    const el = document.getElementById(id);
    const input = el.querySelector('input[type="file"]');
    const span = el.querySelector('span');
    const original = span.innerHTML;

    const accept = (file) => {
      if (!file || !file.type.startsWith('image/')) return;
      span.innerHTML = `${original}<span class="fd-name">${file.name}</span>`;
      el.classList.add('loaded');
      onFile(file);
    };

    input.addEventListener('change', () => accept(input.files[0]));
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('dragover'); });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('dragover');
      accept(e.dataTransfer.files[0]);
    });
  }

  // --- extraction ----------------------------------------------------------

  /* Load an uploaded chart scan and pull out (input -> printed) pairs plus the
     raw strip anchors and the geometry needed to draw the overlay. */
  async function extractScan(file, inputs) {
    const url = URL.createObjectURL(file);
    let im;
    try { im = await loadImageData(url); } finally { URL.revokeObjectURL(url); }

    const fids = detectFiducials(im); // throws if the 4 corners aren't found
    const G = CHART_GEOM;
    const H = solveHomography(
      [G.fiducials.TL, G.fiducials.TR, G.fiducials.BL, G.fiducials.BR],
      [fids.TL, fids.TR, fids.BL, fids.BR],
    );

    const ex = extractChart(im);
    const resp = stripResponse(ex.strips);
    const pairs = ex.patches.map((raw, i) => ({ input: inputs[i], printed: normalizeColor(raw, resp) }));
    // stripResponse already returns { black, gray, white, ref } — exactly the
    // shape rawAnchors() averages across scans.
    const raw = { black: resp.black, gray: resp.gray, white: resp.white, ref: resp.ref };
    return { pairs, raw, im, fids, H };
  }

  /* Like extractScan but for a cols×rows grid chart (the cube / refinement
     charts). Returns centers so the overlay can mark every patch. */
  async function extractCube(file, cols, rows, inputs) {
    const url = URL.createObjectURL(file);
    let im;
    try { im = await loadImageData(url); } finally { URL.revokeObjectURL(url); }

    const ex = extractGridChart(im, cols, rows, inputs.length);
    const resp = stripResponse(ex.strips);
    const pairs = ex.patches.map((raw, i) => ({ input: inputs[i], printed: normalizeColor(raw, resp) }));
    const raw = { black: resp.black, gray: resp.gray, white: resp.white, ref: resp.ref };
    return { pairs, raw, im, fids: ex.fids, H: ex.H, centers: ex.centers };
  }

  /* Draw the scan scaled to fit, then overlay the detected fiducials, the patch
     sample centers and the reference-strip centers so the user can confirm the
     chart was located correctly before trusting the fit. */
  function drawOverlay(canvas, scan) {
    const { im, fids, H } = scan;
    const G = CHART_GEOM;
    const scale = Math.min(1, OVERLAY_MAX / Math.max(im.width, im.height));
    canvas.width = Math.round(im.width * scale);
    canvas.height = Math.round(im.height * scale);
    const ctx = canvas.getContext('2d');

    const tmp = document.createElement('canvas');
    tmp.width = im.width;
    tmp.height = im.height;
    tmp.getContext('2d').putImageData(im, 0, 0);
    ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);

    const dot = (x, y, r, color) => {
      ctx.beginPath();
      ctx.arc(x * scale, y * scale, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };

    // fiducials (rings)
    ctx.strokeStyle = '#e8694a';
    ctx.lineWidth = 2;
    for (const k of ['TL', 'TR', 'BL', 'BR']) {
      const [x, y] = fids[k];
      ctx.beginPath();
      ctx.arc(x * scale, y * scale, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    // patch centers — grid charts pass their own; calibration charts use the 7x7
    const centers = scan.centers || Array.from({ length: 49 }, (_, i) => G.patchCenter(i));
    const r = scan.centers ? 2 : 3;
    for (const pt of centers) {
      const [x, y] = applyH(H, pt);
      dot(x, y, r, 'rgba(232,105,74,0.95)');
    }
    // reference strip centers
    for (const s of ['top', 'bottom'])
      for (const pt of G.strips[s]) {
        const [x, y] = applyH(H, pt);
        dot(...[x, y], 3, 'rgba(80,180,255,0.95)');
      }
  }

  function download(blobOrText, fileName) {
    const blob = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // --- color ---------------------------------------------------------------

  const colorState = { files: { 1: null, 2: null }, json: null };
  const buildColorBtn = document.getElementById('btn-build-color');
  const downloadColorBtn = document.getElementById('btn-download-color');
  const colorStatus = document.getElementById('status-color');

  const refreshColorEnabled = () => {
    buildColorBtn.disabled = !(colorState.files[1] || colorState.files[2]);
  };
  wireDrop('drop-color-1', (f) => { colorState.files[1] = f; refreshColorEnabled(); });
  wireDrop('drop-color-2', (f) => { colorState.files[2] = f; refreshColorEnabled(); });

  buildColorBtn.addEventListener('click', async () => {
    buildColorBtn.disabled = true;
    colorStatus.className = 'hint';
    colorStatus.textContent = 'Reading scans…';
    downloadColorBtn.disabled = true;

    const jobs = [];
    if (colorState.files[1]) jobs.push(['Chart 1', colorState.files[1], COLOR_CHART.patches, 'canvas-color-1']);
    if (colorState.files[2]) jobs.push(['Chart 2', colorState.files[2], COLOR_CHART_2.patches, 'canvas-color-2']);

    try {
      const pairs = [];
      const rawScans = [];
      const sources = [];
      document.getElementById('overlay-color').hidden = false;
      document.getElementById('canvas-color-2').hidden = jobs.length < 2;

      for (const [label, file, inputs, canvasId] of jobs) {
        const scan = await extractScan(file, inputs);
        pairs.push(...scan.pairs);
        rawScans.push(scan.raw);
        sources.push(file.name);
        drawOverlay(document.getElementById(canvasId), scan);
      }

      const model = solveCorrection(pairs);
      const anchors = rawAnchors(rawScans);
      const res = fitResidual(model.predictPrint, pairs);
      const meta = {
        date: new Date().toISOString().slice(0, 10),
        app: `${APP_NAME} v${APP_VERSION}`,
        charts: jobs.length,
        patches: pairs.length,
        sources,
      };
      colorState.json = JSON.stringify(exportCalibration(model, meta, anchors), null, 2);

      downloadColorBtn.disabled = false;
      colorStatus.className = 'hint status-ok';
      colorStatus.innerHTML = `Fit ${pairs.length} patches from ${jobs.length} chart${jobs.length > 1 ? 's' : ''}. `
        + `Fit residual <span class="metric">mean ${(res.mean * 100).toFixed(1)}%, max ${(res.max * 100).toFixed(1)}%</span>. `
        + `Check the overlay, then download.`;
    } catch (err) {
      colorStatus.className = 'hint status-err';
      colorStatus.textContent = detectError(err);
    } finally {
      refreshColorEnabled();
    }
  });

  downloadColorBtn.addEventListener('click', () => {
    if (colorState.json) download(colorState.json, 'calibration-color.json');
  });

  // --- B&W -----------------------------------------------------------------

  const bwState = { file: null, json: null };
  const buildBwBtn = document.getElementById('btn-build-bw');
  const downloadBwBtn = document.getElementById('btn-download-bw');
  const bwStatus = document.getElementById('status-bw');

  wireDrop('drop-bw', (f) => { bwState.file = f; buildBwBtn.disabled = false; });

  buildBwBtn.addEventListener('click', async () => {
    buildBwBtn.disabled = true;
    bwStatus.className = 'hint';
    bwStatus.textContent = 'Reading scan…';
    downloadBwBtn.disabled = true;

    try {
      const scan = await extractScan(bwState.file, BW_CHART.patches);
      document.getElementById('overlay-bw').hidden = false;
      drawOverlay(document.getElementById('canvas-bw'), scan);

      const model = solveBWCalibration(scan.pairs);
      const anchors = rawAnchors([scan.raw]);
      const predictGray = (r, g, b) => {
        const y = model.fwd.eval(clamp01(model.weights[0] * r + model.weights[1] * g + model.weights[2] * b));
        return [y, y, y];
      };
      const res = fitResidual(predictGray, scan.pairs);
      const meta = {
        date: new Date().toISOString().slice(0, 10),
        app: `${APP_NAME} v${APP_VERSION}`,
        patches: scan.pairs.length,
        sources: [bwState.file.name],
      };
      bwState.json = JSON.stringify(exportBWCalibration(model, meta, anchors), null, 2);

      downloadBwBtn.disabled = false;
      bwStatus.className = 'hint status-ok';
      bwStatus.innerHTML = `Fit ${scan.pairs.length} patches. `
        + `Spectral weights R/G/B <span class="metric">${model.weights.map((w) => w.toFixed(2)).join(' / ')}</span>. `
        + `Fit residual <span class="metric">mean ${(res.mean * 100).toFixed(1)}%, max ${(res.max * 100).toFixed(1)}%</span>. `
        + `Check the overlay, then download.`;
    } catch (err) {
      bwStatus.className = 'hint status-err';
      bwStatus.textContent = detectError(err);
    } finally {
      buildBwBtn.disabled = !bwState.file;
    }
  });

  downloadBwBtn.addEventListener('click', () => {
    if (bwState.json) download(bwState.json, 'calibration-bw.json');
  });

  // --- color (high-accuracy 3D cube) ---------------------------------------

  const cubeState = { files: { 1: null, 2: null }, json: null };
  const buildCubeBtn = document.getElementById('btn-build-cube');
  const downloadCubeBtn = document.getElementById('btn-download-cube');
  const cubeStatus = document.getElementById('status-cube');

  const refreshCubeEnabled = () => {
    buildCubeBtn.disabled = !(cubeState.files[1] && cubeState.files[2]);
  };
  wireDrop('drop-cube-1', (f) => { cubeState.files[1] = f; refreshCubeEnabled(); });
  wireDrop('drop-cube-2', (f) => { cubeState.files[2] = f; refreshCubeEnabled(); });

  buildCubeBtn.addEventListener('click', async () => {
    buildCubeBtn.disabled = true;
    downloadCubeBtn.disabled = true;
    cubeStatus.className = 'hint';
    cubeStatus.textContent = 'Reading scans…';

    try {
      const c1 = await extractCube(cubeState.files[1], TEST_CHARTS.cube1.cols, TEST_CHARTS.cube1.rows, TEST_CHARTS.cube1.patches);
      const c2 = await extractCube(cubeState.files[2], TEST_CHARTS.cube2.cols, TEST_CHARTS.cube2.rows, TEST_CHARTS.cube2.patches);
      document.getElementById('overlay-cube').hidden = false;
      drawOverlay(document.getElementById('canvas-cube-1'), c1);
      drawOverlay(document.getElementById('canvas-cube-2'), c2);

      // let the overlay + status paint before the (synchronous) 3D solve blocks
      cubeStatus.textContent = 'Fitting the 3D LUT (a few seconds)…';
      await new Promise((r) => setTimeout(r, 30));

      const pairs = [...c1.pairs, ...c2.pairs];
      const model = solveColorCube(pairs);
      const anchors = rawAnchors([c1.raw, c2.raw]);
      const res = fitResidual(model.predictPrint, pairs);
      const meta = {
        date: new Date().toISOString().slice(0, 10),
        app: `${APP_NAME} v${APP_VERSION}`,
        model: '3d-cube',
        patches: pairs.length,
        sources: [cubeState.files[1].name, cubeState.files[2].name],
      };
      cubeState.json = JSON.stringify(exportColorCubeCalibration(model, meta, anchors), null, 2);

      downloadCubeBtn.disabled = false;
      cubeStatus.className = 'hint status-ok';
      cubeStatus.innerHTML = `Fit a 3D LUT from ${pairs.length} patches. `
        + `Forward-model residual <span class="metric">mean ${(res.mean * 100).toFixed(1)}%, max ${(res.max * 100).toFixed(1)}%</span>. `
        + `Check the overlays, then download. Load it in the corrector for accurate saturated colors.`;
    } catch (err) {
      cubeStatus.className = 'hint status-err';
      cubeStatus.textContent = detectError(err);
    } finally {
      refreshCubeEnabled();
    }
  });

  downloadCubeBtn.addEventListener('click', () => {
    if (cubeState.json) download(cubeState.json, 'calibration-color-cube.json');
  });

  // --- shared helpers ------------------------------------------------------

  /* Mean / max absolute prediction error of the fitted forward model against
     the (normalized) measured patches — a quick honesty check on the fit. */
  function fitResidual(predict, pairs) {
    let sum = 0, max = 0, n = 0;
    for (const { input, printed } of pairs) {
      const pred = predict(...input);
      for (let c = 0; c < 3; c++) {
        const e = Math.abs(pred[c] - printed[c]);
        sum += e;
        if (e > max) max = e;
        n++;
      }
    }
    return { mean: sum / n, max };
  }

  /* Turn an extraction error into a user-actionable message. */
  function detectError(err) {
    const m = String(err && err.message || err);
    if (/fiducial/i.test(m))
      return 'Could not find the 4 black corner squares. Make sure the whole chart '
        + '(including its corners) is in frame, evenly lit, not too skewed, and that '
        + 'the scan is the calibration chart from this app.';
    return 'Could not process that scan: ' + m;
  }

  // --- download all charts as a .zip --------------------------------------

  // every chart: [drawFn, definition]. Same set the corrector's Advanced panel
  // exposes, rendered fresh here so the version stamp always matches.
  const ALL_CHARTS = [
    [drawChart, COLOR_CHART], [drawChart, COLOR_CHART_2], [drawChart, BW_CHART],
    [drawGridChart, TEST_CHARTS.cube1], [drawGridChart, TEST_CHARTS.cube2],
    [drawGridChart, TEST_CHARTS.extreme], [drawGridChart, TEST_CHARTS.repeat],
    [drawFlatField, TEST_CHARTS.vignette],
  ];

  function chartToPng(draw, chart) {
    const canvas = document.createElement('canvas');
    draw(canvas, chart);
    return new Promise((res) => canvas.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), 'image/png'));
  }

  /* Minimal store-method (no compression) ZIP writer — PNGs are already
     compressed, so storing them keeps this dependency-free and tiny. */
  function makeZip(files) {
    const enc = new TextEncoder();
    const u16 = (n) => new Uint8Array([n & 255, (n >> 8) & 255]);
    const u32 = (n) => new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
    const crc32 = (bytes) => {
      let c = ~0;
      for (let i = 0; i < bytes.length; i++) {
        c ^= bytes[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
      }
      return (~c) >>> 0;
    };

    const chunks = [];
    const central = [];
    let offset = 0;
    const push = (arr) => { chunks.push(arr); offset += arr.length; };

    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;
      const localOffset = offset;
      push(u32(0x04034b50)); push(u16(20)); push(u16(0)); push(u16(0)); // sig, ver, flags, store
      push(u16(0)); push(u16(0));                                       // mod time/date
      push(u32(crc)); push(u32(size)); push(u32(size));
      push(u16(name.length)); push(u16(0));
      push(name); push(f.data);

      central.push([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(localOffset), name,
      ]);
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) for (const a of c) { push(a); cdSize += a.length; }
    push(u32(0x06054b50)); push(u16(0)); push(u16(0));
    push(u16(files.length)); push(u16(files.length));
    push(u32(cdSize)); push(u32(cdStart)); push(u16(0));

    return new Blob(chunks, { type: 'application/zip' });
  }

  const zipBtn = document.getElementById('btn-download-all-charts');
  const zipStatus = document.getElementById('zip-status');
  const zipNote = zipStatus.textContent;
  zipBtn.addEventListener('click', async () => {
    zipBtn.disabled = true;
    zipStatus.textContent = 'Rendering charts…';
    try {
      const files = [];
      for (const [draw, chart] of ALL_CHARTS) {
        files.push({ name: chart.file.replace(/\.png$/, `-v${APP_VERSION}.png`), data: await chartToPng(draw, chart) });
      }
      download(makeZip(files), `polaroid-lab-charts-v${APP_VERSION}.zip`);
      zipStatus.textContent = `Downloaded ${files.length} charts as polaroid-lab-charts-v${APP_VERSION}.zip.`;
    } catch (err) {
      zipStatus.textContent = 'Could not build the zip: ' + (err && err.message || err);
    } finally {
      zipBtn.disabled = false;
      setTimeout(() => { zipStatus.textContent = zipNote; }, 6000);
    }
  });

  // individual chart downloads — one button each (handier on a phone)
  const CHART_LABELS = {
    'color-v1': 'Color chart 1', 'color-v2': 'Color chart 2', 'bw-v1': 'B&W chart',
    'color-cube-1': 'Color cube 1 / 2', 'color-cube-2': 'Color cube 2 / 2',
    'extreme-tone': 'Extreme tone', 'repeatability': 'Repeatability', 'vignette-field': 'Vignette field',
  };
  const chartListEl = document.getElementById('chart-list');
  for (const [draw, chart] of ALL_CHARTS) {
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = CHART_LABELS[chart.id] || chart.id;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const data = await chartToPng(draw, chart);
        download(new Blob([data], { type: 'image/png' }), chart.file.replace(/\.png$/, `-v${APP_VERSION}.png`));
      } finally {
        btn.disabled = false;
      }
    });
    chartListEl.append(btn);
  }
})();
