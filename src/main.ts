// App shell: file input -> PLY load -> interactive turntable preview -> streaming
// render+encode export. Milestone 3 adds the full settings form: presets, grouped
// camera/colour/animation/output controls, even-dimension validation, a live colour
// pipeline (auto-brighten + brightness slider + faithful/off), and an encoder
// support surface driven by VideoEncoder.isConfigSupported.

import { loadPlyFromFile, applyColorSettings, type LoadedPly } from './ply/load';
import {
  DEFAULT_COLOR_SETTINGS,
  type ColorMode,
  type ColorResolveInfo,
  type ColorSettings,
} from './ply/color';
import { TurntablePreview, DEFAULT_CAMERA_PARAMS } from './scene/preview';
import type { Axis, SpinDirection } from './camera/turntable';
import { ExportController } from './export/exportController';
import type { RenderExportOptions } from './export/protocol';
import { pickSupportedConfig } from './encode/encoderConfig';
import {
  PRESETS,
  SIZE_OPTIONS,
  clampDuration,
  deriveFrameCount,
  dimensionsFor,
  matchPresetId,
  normalizeEvenDimension,
  presetLabel,
  type AspectRatio,
  type OutputSettings,
} from './settings/output';
import { registerSW } from 'virtual:pwa-register';

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
const themeToggle = must<HTMLButtonElement>('themeToggle');
const info = must<HTMLParagraphElement>('info');
const warnings = must<HTMLUListElement>('warnings');
const controls = must<HTMLFieldSetElement>('controls');

const presetsBar = must<HTMLDivElement>('presets');
const presetTag = must<HTMLSpanElement>('presetLabel');

const axisSel = must<HTMLSelectElement>('axis');
const fovInput = must<HTMLInputElement>('fov');
const fovOut = must<HTMLOutputElement>('fovOut');
const marginInput = must<HTMLInputElement>('margin');
const marginOut = must<HTMLOutputElement>('marginOut');
const directionSel = must<HTMLSelectElement>('direction');
const turnsInput = must<HTMLInputElement>('turns');
const exportCam = must<HTMLInputElement>('exportCam');
const pointSizeAutoField = must<HTMLLabelElement>('pointSizeAutoField');
const pointSizeAuto = must<HTMLInputElement>('pointSizeAuto');
const pointSizeField = must<HTMLDivElement>('pointSizeField');
const pointSizeInput = must<HTMLInputElement>('pointSize');
const pointSizeOut = must<HTMLOutputElement>('pointSizeOut');

const colorModeSel = must<HTMLSelectElement>('colorMode');
const brightnessInput = must<HTMLInputElement>('brightness');
const brightnessOut = must<HTMLOutputElement>('brightnessOut');
const brightnessField = must<HTMLDivElement>('brightnessField');
const colorHint = must<HTMLParagraphElement>('colorHint');

const swatches = must<HTMLDivElement>('swatches');
const bgPicker = must<HTMLInputElement>('bgPicker');

const sizeSel = must<HTMLSelectElement>('size');
const customSizeField = must<HTMLDivElement>('customSizeField');
const customSize = must<HTMLInputElement>('customSize');
const aspectSel = must<HTMLSelectElement>('aspect');
const sizeNote = must<HTMLParagraphElement>('sizeNote');
const resInfo = must<HTMLParagraphElement>('resInfo');
const fpsSel = must<HTMLSelectElement>('fps');
const durationInput = must<HTMLInputElement>('duration');
const durationOut = must<HTMLOutputElement>('durationOut');
const frameInfo = must<HTMLParagraphElement>('frameInfo');

const bitrateInput = must<HTMLInputElement>('bitrate');
const bitrateOut = must<HTMLOutputElement>('bitrateOut');

const renderBtn = must<HTMLButtonElement>('renderBtn');
const cancelBtn = must<HTMLButtonElement>('cancelBtn');
const exportProgress = must<HTMLDivElement>('exportProgress');
const progressBar = must<HTMLProgressElement>('progressBar');
const progressLabel = must<HTMLSpanElement>('progressLabel');
const downloadLink = must<HTMLAnchorElement>('downloadLink');
const retryBtn = must<HTMLButtonElement>('retryBtn');
const exportError = must<HTMLParagraphElement>('exportError');
const supportNote = must<HTMLParagraphElement>('supportNote');

const preview = new TurntablePreview(canvas);
const exporter = new ExportController();

let currentModel: LoadedPly | null = null;
let currentBackground = '#ffffff';
let colorSettings: ColorSettings = { ...DEFAULT_COLOR_SETTINGS };
/** Smallest square export dimension we will retry down to. */
const MIN_EXPORT_SIZE = 256;

function showInfo(loaded: LoadedPly): void {
  const kind = loaded.isPoints ? 'point cloud' : 'mesh';
  const n = loaded.vertexCount.toLocaleString();
  info.innerHTML = `<span class="count">${n}</span> vertices &middot; ${kind}${
    loaded.color ? ' &middot; coloured' : ''
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
    preview.setBackground(currentBackground);
    showInfo(loaded);
    controls.disabled = false;
    dropzone.classList.add('hidden');
    // Point-size controls only apply to point clouds.
    pointSizeAutoField.hidden = !loaded.isPoints;
    pointSizeField.hidden = !loaded.isPoints;
    applyPointSize();
    updateStageAspect();
    refreshColor();
    syncPresetLabel();
    void refreshSupport();
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

// --- Theme (auto dark mode + manual override) ------------------------------

type ThemePref = 'auto' | 'light' | 'dark';
const THEME_ICON: Record<ThemePref, string> = { auto: '🌗', light: '☀️', dark: '🌙' };
const THEME_NEXT: Record<ThemePref, ThemePref> = { auto: 'light', light: 'dark', dark: 'auto' };
const THEME_HINT: Record<ThemePref, string> = {
  auto: 'Theme: follows system (click for light)',
  light: 'Theme: light (click for dark)',
  dark: 'Theme: dark (click to follow system)',
};

function currentThemePref(): ThemePref {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'auto';
}

/** Apply a theme choice: 'auto' leaves the media query in charge; else pin it. */
function applyThemePref(pref: ThemePref): void {
  if (pref === 'auto') {
    delete document.documentElement.dataset.theme;
    try {
      localStorage.removeItem('theme');
    } catch {
      /* storage may be unavailable (private mode) — theme still applies live */
    }
  } else {
    document.documentElement.dataset.theme = pref;
    try {
      localStorage.setItem('theme', pref);
    } catch {
      /* ignore */
    }
  }
  themeToggle.textContent = THEME_ICON[pref];
  themeToggle.title = THEME_HINT[pref];
  themeToggle.setAttribute('aria-label', THEME_HINT[pref]);
}

applyThemePref(currentThemePref());
themeToggle.addEventListener('click', () => applyThemePref(THEME_NEXT[currentThemePref()]));

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

// --- Point size (point clouds only) ----------------------------------------

/** Absolute point diameter the user chose, or null to use the auto heuristic. */
function pointSizeValue(): number | null {
  return pointSizeAuto.checked ? null : Number(pointSizeInput.value);
}

function applyPointSize(): void {
  const override = pointSizeValue();
  pointSizeInput.disabled = override === null;
  pointSizeOut.textContent = override === null ? 'Auto' : override.toFixed(1);
  preview.setPointSize(override);
}

pointSizeAuto.addEventListener('change', applyPointSize);
pointSizeInput.addEventListener('input', applyPointSize);

// --- Colour ----------------------------------------------------------------

/** Brightness slider is in EV stops; the pipeline wants a linear multiplier. */
function brightnessMultiplier(): number {
  return 2 ** Number(brightnessInput.value);
}

function describeColor(info: ColorResolveInfo): string {
  if (colorSettings.mode === 'off') return 'Vertex colour hidden.';
  if (colorSettings.mode === 'faithful') return 'Faithful 8-bit colour (matches the CLI).';
  const src = info.source === 'rgb16' ? '16-bit' : '8-bit';
  return `Auto-brightened ${src} colour · ~${info.totalGain.toFixed(info.totalGain < 10 ? 1 : 0)}×`;
}

/** Re-bake the loaded model's colours under the current settings and sync the UI. */
function refreshColor(): void {
  const hasColorData = Boolean(currentModel?.color);
  colorModeSel.disabled = !hasColorData;
  brightnessInput.disabled = !hasColorData;
  brightnessField.hidden = colorSettings.mode !== 'auto';

  if (!currentModel) return;
  if (!hasColorData) {
    colorHint.textContent = 'No colour data in this file — using a neutral fill.';
    return;
  }
  const info = applyColorSettings(currentModel, colorSettings);
  preview.refreshColors();
  colorHint.textContent = describeColor(info);
}

colorModeSel.addEventListener('change', () => {
  colorSettings = { ...colorSettings, mode: colorModeSel.value as ColorMode };
  refreshColor();
});

brightnessInput.addEventListener('input', () => {
  const mult = brightnessMultiplier();
  brightnessOut.textContent = `${mult.toFixed(mult < 10 ? 1 : 0)}×`;
  colorSettings = { ...colorSettings, brightness: mult };
  refreshColor();
});

// --- Background ------------------------------------------------------------

function selectBackground(color: string, pressedSwatch: HTMLButtonElement | null): void {
  currentBackground = color;
  preview.setBackground(currentBackground);
  swatches.querySelectorAll<HTMLButtonElement>('.swatch').forEach((s) => {
    s.setAttribute('aria-pressed', String(s === pressedSwatch));
  });
}

swatches.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.swatch');
  if (!btn) return;
  const color = btn.dataset.color ?? '#ffffff';
  bgPicker.value = color;
  selectBackground(color, btn);
});

bgPicker.addEventListener('input', () => {
  selectBackground(bgPicker.value, null);
});

// --- Output / presets / validation -----------------------------------------

/** Effective long-edge dimension (custom input already normalized to even). */
function currentSize(): number {
  if (sizeSel.value === 'custom') return normalizeEvenDimension(Number(customSize.value)).value;
  return Number(sizeSel.value) || 1080;
}

function currentAspect(): AspectRatio {
  return aspectSel.value === '16:9' ? '16:9' : '1:1';
}

/** Even width/height derived from the long edge + aspect. */
function currentDimensions(): { width: number; height: number } {
  return dimensionsFor(currentSize(), currentAspect());
}

function currentFps(): number {
  return Number(fpsSel.value) || 30;
}

function currentDurationSeconds(): number {
  return clampDuration(Number(durationInput.value));
}

function currentOutput(): OutputSettings {
  return {
    size: currentSize(),
    fps: currentFps(),
    durationSeconds: currentDurationSeconds(),
    aspect: currentAspect(),
  };
}

/** Point the preview stage at the chosen aspect and re-frame once it resizes. */
function updateStageAspect(): void {
  stage.dataset.aspect = currentAspect();
  requestAnimationFrame(() => preview.reframe());
}

aspectSel.addEventListener('change', () => {
  updateStageAspect();
  updateResInfo();
  syncPresetLabel();
  void refreshSupport();
});

function updateFrameInfo(): void {
  const frames = deriveFrameCount(currentDurationSeconds(), currentFps());
  frameInfo.textContent = `${frames.toLocaleString()} frames`;
}

/** Show the derived output resolution (long edge + aspect -> width x height). */
function updateResInfo(): void {
  const { width, height } = currentDimensions();
  resInfo.textContent = `${width} × ${height}`;
}

/** Reflect whether the current output triple matches a named preset (gpt #21). */
function syncPresetLabel(): void {
  const out = currentOutput();
  const id = matchPresetId(out);
  presetTag.textContent = presetLabel(out);
  presetsBar.querySelectorAll<HTMLButtonElement>('.preset').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.preset === id));
  });
}

function applyPreset(id: string): void {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return;
  const { size, fps, durationSeconds, aspect } = preset.output;

  if ((SIZE_OPTIONS as readonly number[]).includes(size)) {
    sizeSel.value = String(size);
    customSizeField.hidden = true;
  } else {
    sizeSel.value = 'custom';
    customSizeField.hidden = false;
    customSize.value = String(size);
  }
  sizeNote.textContent = '';
  fpsSel.value = String(fps);
  durationInput.value = String(durationSeconds);
  durationOut.textContent = `${durationSeconds}s`;
  aspectSel.value = aspect;
  updateStageAspect();

  updateFrameInfo();
  updateResInfo();
  syncPresetLabel();
  void refreshSupport();
}

presetsBar.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.preset');
  if (btn?.dataset.preset) applyPreset(btn.dataset.preset);
});

/** Normalize the custom-size input to an even, in-range value with a note (gpt #19). */
function applyCustomSize(): void {
  const r = normalizeEvenDimension(Number(customSize.value));
  customSize.value = String(r.value);
  sizeNote.textContent = r.message ?? '';
  updateResInfo();
  syncPresetLabel();
  void refreshSupport();
}

sizeSel.addEventListener('change', () => {
  const custom = sizeSel.value === 'custom';
  customSizeField.hidden = !custom;
  if (custom) applyCustomSize();
  else sizeNote.textContent = '';
  updateResInfo();
  syncPresetLabel();
  void refreshSupport();
});
customSize.addEventListener('change', applyCustomSize);

durationInput.addEventListener('input', () => {
  durationOut.textContent = `${currentDurationSeconds()}s`;
  updateFrameInfo();
  syncPresetLabel();
});
fpsSel.addEventListener('change', () => {
  updateFrameInfo();
  syncPresetLabel();
  void refreshSupport();
});

bitrateInput.addEventListener('input', () => {
  const mbps = Number(bitrateInput.value);
  bitrateOut.textContent = mbps === 0 ? 'Auto' : `${mbps} Mbps`;
});

updateFrameInfo();
updateResInfo();
syncPresetLabel();

// --- Encoder support surface ------------------------------------------------

let supportToken = 0;
/** Probe isConfigSupported for the current size/fps; surface an unsupported message. */
async function refreshSupport(): Promise<void> {
  const token = ++supportToken;
  const { width, height } = currentDimensions();
  const fps = currentFps();
  try {
    const picked = await pickSupportedConfig({ width, height, fps });
    if (token !== supportToken) return;
    if (picked) {
      supportNote.textContent = '';
      if (cancelBtn.hidden) renderBtn.disabled = false;
    } else {
      supportNote.textContent = `This browser can't encode ${width}×${height} @ ${fps}fps as MP4 or WebM. Try a smaller size or another browser.`;
      renderBtn.disabled = true;
    }
  } catch {
    if (token === supportToken) supportNote.textContent = '';
  }
}

// --- Export ----------------------------------------------------------------

/** Read the full render request from the current control state. */
function buildOptions(): RenderExportOptions {
  const { width, height } = currentDimensions();
  const mbps = Number(bitrateInput.value);
  const override = pointSizeValue();
  // Optional codec override (debug / E2E): lets us exercise the VP9->WebM path.
  const forced = (window as unknown as { __forceMediabunnyCodec?: 'avc' | 'vp9' })
    .__forceMediabunnyCodec;
  return {
    width,
    height,
    fps: currentFps(),
    durationSeconds: currentDurationSeconds(),
    axis: axisSel.value as Axis,
    verticalFovDeg: Number(fovInput.value) || DEFAULT_CAMERA_PARAMS.verticalFovDeg,
    margin: Number(marginInput.value) || DEFAULT_CAMERA_PARAMS.margin,
    turns: Math.max(1, Math.round(Number(turnsInput.value) || 1)),
    direction: directionSel.value as SpinDirection,
    background: currentBackground,
    ...(override !== null ? { pointSizeOverride: override } : {}),
    ...(mbps > 0 ? { bitrate: mbps * 1_000_000 } : {}),
    ...(forced ? { forceMediabunnyCodec: forced } : {}),
  };
}

/** Halve an export for the lower-resolution retry, keeping both edges even. */
function halveOptions(options: RenderExportOptions): RenderExportOptions {
  const w = Math.max(MIN_EXPORT_SIZE, Math.round(options.width / 2));
  const h = Math.max(2, Math.round(options.height / 2));
  return { ...options, width: w - (w % 2), height: h - (h % 2) };
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

// --- Service worker (PWA) -----------------------------------------------------
// registerType is 'prompt', so a new deploy waits until the user clicks Reload —
// we never hot-swap worker code mid-export. In dev (no built SW) registerSW is a
// no-op and neither callback fires, so the toast simply stays hidden.
const pwaToast = must<HTMLDivElement>('pwaToast');
const pwaToastMsg = must<HTMLSpanElement>('pwaToastMsg');
const pwaReload = must<HTMLButtonElement>('pwaReload');
const pwaDismiss = must<HTMLButtonElement>('pwaDismiss');

function showToast(message: string, offerReload: boolean): void {
  pwaToastMsg.textContent = message;
  pwaReload.hidden = !offerReload;
  pwaToast.hidden = false;
}

pwaDismiss.addEventListener('click', () => {
  pwaToast.hidden = true;
});

const updateServiceWorker = registerSW({
  onNeedRefresh() {
    // A newer build is cached and waiting. Activate it (skipWaiting) + reload only
    // when the user asks, so an in-flight render is never interrupted.
    pwaReload.onclick = () => void updateServiceWorker(true);
    showToast('A new version is available.', true);
  },
  onOfflineReady() {
    showToast('Ready to work offline.', false);
    // Transient confirmation; auto-dismiss unless an update prompt is also up.
    globalThis.setTimeout(() => {
      if (pwaReload.hidden) pwaToast.hidden = true;
    }, 5000);
  },
});
