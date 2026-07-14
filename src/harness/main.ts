/**
 * Harness page bootstrap. Provides a hands-on UI for the compat spike and, more
 * importantly, exposes the spike entry points on `window` so a Playwright driver
 * can run them headless in Chromium and Firefox and read back JSON results.
 */

import {
  runCompat,
  runSupportMatrix,
  DEFAULT_CONFIGS,
  type CompatRequest,
  type CompatResult,
  type MatrixEntry,
} from './compat.js';

declare global {
  interface Window {
    __runCompat: (req: CompatRequest) => Promise<CompatResult>;
    __runSupportMatrix: (configs?: CompatRequest[]) => Promise<MatrixEntry[]>;
    __defaultConfigs: CompatRequest[];
  }
}

window.__runCompat = runCompat;
window.__runSupportMatrix = (configs = DEFAULT_CONFIGS) => runSupportMatrix(configs);
window.__defaultConfigs = DEFAULT_CONFIGS;

// --- Minimal interactive UI ---------------------------------------------------
const app = document.getElementById('app');
if (app) {
  const matrixBtn = document.createElement('button');
  matrixBtn.textContent = 'Run support matrix';
  const out = document.createElement('pre');
  out.style.whiteSpace = 'pre-wrap';
  const status = document.createElement('p');

  const configRow = document.createElement('div');
  configRow.style.display = 'flex';
  configRow.style.flexWrap = 'wrap';
  configRow.style.gap = '0.5rem';

  const video = document.createElement('video');
  video.controls = true;
  video.muted = true;
  video.style.maxWidth = '360px';
  video.style.display = 'block';
  video.style.marginTop = '1rem';

  for (const cfg of DEFAULT_CONFIGS) {
    const btn = document.createElement('button');
    btn.textContent = `Spike ${cfg.width}x${cfg.height}@${cfg.fps}`;
    btn.addEventListener('click', async () => {
      status.textContent = `Running ${cfg.width}x${cfg.height}@${cfg.fps}...`;
      const result = await runCompat(cfg);
      out.textContent = JSON.stringify(result, null, 2);
      status.textContent = result.ok ? '✅ passed' : `❌ ${result.error ?? 'checks failed'}`;
    });
    configRow.appendChild(btn);
  }

  matrixBtn.addEventListener('click', async () => {
    status.textContent = 'Probing candidates...';
    const matrix = await runSupportMatrix(DEFAULT_CONFIGS);
    out.textContent = JSON.stringify(matrix, null, 2);
    status.textContent = 'Support matrix ready.';
  });

  app.append(matrixBtn, configRow, status, video, out);
}
