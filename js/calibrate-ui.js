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
    // 49 patch centers
    for (let i = 0; i < 49; i++) {
      const [x, y] = applyH(H, G.patchCenter(i));
      dot(x, y, 3, 'rgba(232,105,74,0.95)');
    }
    // reference strip centers
    for (const s of ['top', 'bottom'])
      for (const pt of G.strips[s]) {
        const [x, y] = applyH(H, pt);
        dot(...[x, y], 3, 'rgba(80,180,255,0.95)');
      }
  }

  function download(text, fileName) {
    const blob = new Blob([text], { type: 'application/json' });
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
})();
