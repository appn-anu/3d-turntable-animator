// App shell: file input -> PLY load -> interactive turntable preview -> streaming
// render+encode export. The full settings UI (presets, validation) arrives in
// Milestone 3; this wires up enough camera + output controls to produce a video.

import { loadPlyFromFile, type LoadedPly } from './ply/load';
import { TurntablePreview, DEFAULT_CAMERA_PARAMS } from './scene/preview';
import type { Axis, SpinDirection } from './camera/turntable';
import { ExportController } from './export/exportController';
import type { RenderExportOptions } from './export/protocol';
import { frameCount } from './encode/timestamps';

function must<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as unknown as T;
}

const canvas = must<HTMLCanvasElement>('preview');
const stage = must<HTMLDivElement>('stage');
const dropzone = must<HTMLDivElement>('dropzone');
const fileInput = must<HTMLInputElement>('file');
const loadBtn = must<HTMLButtonElement>('loadBtn');
const info = must<HTMLParagraphElement>('info');
const warnings = must<HTMLUListElement>('warnings');
const controls = must<HTMLFieldSetElement>('controls');

const axisSel = must<HTMLSelectElement>('axis');
const fovInput = must<HTMLInputElement>('fov');
const fovOut = must<HTMLOutputElement>('fovOut');
const marginInput = must<HTMLInputElement>('margin');
const marginOut = must<HTMLOutputElement>('marginOut');
const directionSel = must<HTMLSelectElement>('direction');
const turnsInput = must<HTMLInputElement>('turns');
const exportCam = must<HTMLInputElement>('exportCam');
const swatches = must<HTMLDivElement>('swatches');

const sizeSel = must<HTMLSelectElement>('size');
const fpsSel = must<HTMLSelectElement>('fps');
const durationInput = must<HTMLInputElement>('duration');
const durationOut = must<HTMLOutputElement>('durationOut');
const frameInfo = must<HTMLParagraphElement>('frameInfo');
const renderBtn = must<HTMLButtonElement>('renderBtn');
const cancelBtn = must<HTMLButtonElement>('cancelBtn');
const exportProgress = must<HTMLDivElement>('exportProgress');
const progressBar = must<HTMLProgressElement>('progressBar');
const progressLabel = must<HTMLSpanElement>('progressLabel');
const downloadLink = must<HTMLAnchorElement>('downloadLink');
const retryBtn = must<HTMLButtonElement>('retryBtn');
const exportError = must<HTMLParagraphElement>('exportError');

const preview = new TurntablePreview(canvas);
const exporter = new ExportController();

let currentModel: LoadedPly | null = null;
let currentBackground = '#ffffff';
/** Smallest square export dimension we will retry down to. */
const MIN_EXPORT_SIZE = 256;

function showInfo(loaded: LoadedPly): void {
  const kind = loaded.isPoints ? 'point cloud' : 'mesh';
  const n = loaded.vertexCount.toLocaleString();
  info.innerHTML = `<span class="count">${n}</span> vertices &middot; ${kind}${
    loaded.hasColors ? ' &middot; coloured' : ''
  }`;
  warnings.replaceChildren(
    ...loaded.warnings.map((w) => {
      const li = document.createElement('li');
      li.textContent = w;
      return li;
    }),
  );
}

async function loadFile(file: File): Promise<void> {
  info.textContent = `Loading ${file.name}…`;
  warnings.replaceChildren();
  resetExportUI();
  try {
    const loaded = await loadPlyFromFile(file);
    currentModel = loaded;
    preview.setModel(loaded);
    showInfo(loaded);
    controls.disabled = false;
    dropzone.classList.add('hidden');
  } catch (err) {
    currentModel = null;
    controls.disabled = true;
    dropzone.classList.remove('hidden');
    info.textContent = err instanceof Error ? err.message : 'Failed to load file.';
  }
}

// --- File selection --------------------------------------------------------

loadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file);
});

// --- Drag & drop -----------------------------------------------------------

stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  stage.classList.add('dragover');
});
stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});

// --- Camera controls -------------------------------------------------------

axisSel.value = DEFAULT_CAMERA_PARAMS.axis;
axisSel.addEventListener('change', () => {
  preview.setCameraParams({ axis: axisSel.value as Axis });
});

fovInput.addEventListener('input', () => {
  const deg = Number(fovInput.value);
  fovOut.textContent = `${deg}°`;
  preview.setCameraParams({ verticalFovDeg: deg });
});

marginInput.addEventListener('input', () => {
  const margin = Number(marginInput.value);
  marginOut.textContent = margin.toFixed(2);
  preview.setCameraParams({ margin });
});

directionSel.addEventListener('change', () => {
  preview.setCameraParams({ direction: directionSel.value as SpinDirection });
});

turnsInput.addEventListener('change', () => {
  const turns = Math.max(1, Math.round(Number(turnsInput.value) || 1));
  turnsInput.value = String(turns);
  preview.setCameraParams({ turns });
});

exportCam.addEventListener('change', () => {
  preview.setExportCameraLock(exportCam.checked);
});

// --- Background swatches ----------------------------------------------------

swatches.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.swatch');
  if (!btn) return;
  currentBackground = btn.dataset.color ?? '#ffffff';
  preview.setBackground(currentBackground);
  swatches.querySelectorAll<HTMLButtonElement>('.swatch').forEach((s) => {
    s.setAttribute('aria-pressed', String(s === btn));
  });
});

// --- Export ----------------------------------------------------------------

function currentDurationSeconds(): number {
  return Math.max(1, Math.round(Number(durationInput.value) || 1));
}

function currentFps(): number {
  return Number(fpsSel.value) || 30;
}

function updateFrameInfo(): void {
  const frames = frameCount(currentDurationSeconds(), currentFps());
  frameInfo.textContent = `${frames.toLocaleString()} frames`;
}

durationInput.addEventListener('input', () => {
  durationOut.textContent = `${currentDurationSeconds()}s`;
  updateFrameInfo();
});
fpsSel.addEventListener('change', updateFrameInfo);
updateFrameInfo();

/** Read the full render request from the current control state. */
function buildOptions(): RenderExportOptions {
  const size = Number(sizeSel.value) || 1080;
  // Optional codec override (debug / E2E): lets us exercise the VP9->WebM path.
  const forced = (window as unknown as { __forceMediabunnyCodec?: 'avc' | 'vp9' })
    .__forceMediabunnyCodec;
  return {
    width: size,
    height: size,
    fps: currentFps(),
    durationSeconds: currentDurationSeconds(),
    axis: axisSel.value as Axis,
    verticalFovDeg: Number(fovInput.value) || DEFAULT_CAMERA_PARAMS.verticalFovDeg,
    margin: Number(marginInput.value) || DEFAULT_CAMERA_PARAMS.margin,
    turns: Math.max(1, Math.round(Number(turnsInput.value) || 1)),
    direction: directionSel.value as SpinDirection,
    background: currentBackground,
    ...(forced ? { forceMediabunnyCodec: forced } : {}),
  };
}

/** Halve a square export for the lower-resolution retry, keeping it even. */
function halveOptions(options: RenderExportOptions): RenderExportOptions {
  const halved = Math.max(MIN_EXPORT_SIZE, Math.round(options.width / 2));
  const even = halved - (halved % 2);
  return { ...options, width: even, height: even };
}

let lastOptions: RenderExportOptions | null = null;

function resetExportUI(): void {
  exporter.cancel();
  exportProgress.hidden = true;
  progressBar.value = 0;
  progressLabel.textContent = '';
  downloadLink.hidden = true;
  downloadLink.removeAttribute('href');
  retryBtn.hidden = true;
  exportError.textContent = '';
  renderBtn.hidden = false;
  renderBtn.disabled = false;
  cancelBtn.hidden = true;
}

function enterRunningUI(): void {
  renderBtn.hidden = true;
  cancelBtn.hidden = false;
  exportProgress.hidden = false;
  progressBar.value = 0;
  progressLabel.textContent = 'Starting…';
  downloadLink.hidden = true;
  retryBtn.hidden = true;
  exportError.textContent = '';
}

function exitRunningUI(): void {
  renderBtn.hidden = false;
  cancelBtn.hidden = true;
}

function handleCanceled(): void {
  exitRunningUI();
  exportProgress.hidden = true;
  progressLabel.textContent = '';
}

function startExport(options: RenderExportOptions): void {
  if (!currentModel) return;
  lastOptions = options;
  enterRunningUI();
  exporter.start(currentModel, options, {
    onProgress: (state) => {
      exportProgress.hidden = false;
      progressBar.value = state.percent;
      progressLabel.textContent = `${state.label} · ${state.percent}%`;
    },
    onDone: (state) => {
      exitRunningUI();
      downloadLink.href = state.url;
      downloadLink.download = state.filename;
      downloadLink.hidden = false;
      downloadLink.textContent = `Download ${state.filename}`;
      exposeResult(state.blob, state.container, state.filename, state.url);
    },
    onError: (state) => {
      exitRunningUI();
      exportProgress.hidden = true;
      exportError.textContent = state.message;
      const retryable =
        state.canRetryLowerRes && (lastOptions?.width ?? 0) / 2 >= MIN_EXPORT_SIZE;
      retryBtn.hidden = !retryable;
    },
    onCanceled: handleCanceled,
  });
}

renderBtn.addEventListener('click', () => {
  if (!currentModel) return;
  startExport(buildOptions());
});

cancelBtn.addEventListener('click', () => {
  exporter.cancel({ onCanceled: handleCanceled });
});

retryBtn.addEventListener('click', () => {
  if (!lastOptions) return;
  startExport(halveOptions(lastOptions));
});

// Debug/E2E hook: the last produced video's stats, for headless verification.
interface ExportDebug {
  __exportResult?: { size: number; type: string; container: string; filename: string };
  __exportBlobUrl?: string;
}
function exposeResult(blob: Blob, container: string, filename: string, url: string): void {
  const debug = window as unknown as ExportDebug;
  debug.__exportResult = { size: blob.size, type: blob.type, container, filename };
  debug.__exportBlobUrl = url;
}

window.addEventListener('beforeunload', () => {
  exporter.dispose();
  preview.dispose();
});
