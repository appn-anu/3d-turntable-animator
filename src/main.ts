// App shell: file input -> PLY load -> interactive turntable preview.
// Full settings UI (presets, validation, render/export) arrives in later milestones;
// this wires up enough camera controls to eyeball parity against the CLI render.

import { loadPlyFromFile, type LoadedPly } from './ply/load';
import { TurntablePreview, DEFAULT_CAMERA_PARAMS } from './scene/preview';
import type { Axis, SpinDirection } from './camera/turntable';

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

const preview = new TurntablePreview(canvas);

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
  try {
    const loaded = await loadPlyFromFile(file);
    preview.setModel(loaded);
    showInfo(loaded);
    controls.disabled = false;
    dropzone.classList.add('hidden');
  } catch (err) {
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
  const color = btn.dataset.color ?? '#ffffff';
  preview.setBackground(color);
  swatches.querySelectorAll<HTMLButtonElement>('.swatch').forEach((s) => {
    s.setAttribute('aria-pressed', String(s === btn));
  });
});

window.addEventListener('beforeunload', () => preview.dispose());
