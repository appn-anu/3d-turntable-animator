// PLY loading + normalization.
//
// Wraps Three's PLYLoader and produces a canonical, preview-ready geometry that
// matches the reference CLI's conventions:
//   - No faces (geometry has no index) -> render as THREE.Points; else a lit mesh.
//   - Centered at the origin via its axis-aligned bounding box (CLI centers on the
//     bbox center so the turntable spin is clean).
//   - Vertex colours run through the colour pipeline (`color.ts`): the raw 8-bit and
//     (when present) 16-bit red16/green16/blue16 channels are kept, and the current
//     colour settings are baked into a linear-space `color` attribute so a
//     color-managed sRGB-output renderer reproduces them. Default is Auto
//     (auto-brighten preferring the 16-bit channels); see [[wheat-colour-finding]].
//
// Also reports a rotation-safe bounding-sphere radius (measured from the origin,
// so it stays valid at every turntable angle) for the camera fit (gpt #5), plus
// warnings for the edge cases the UI should surface.

import { BufferGeometry, Float32BufferAttribute } from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import {
  DEFAULT_COLOR_SETTINGS,
  makeRawColor,
  resolveColors,
  type ColorResolveInfo,
  type ColorSettings,
  type RawColor,
} from './color';

/** Warn (not fail) above this many points — decimation is a post-v1 concern. */
export const LARGE_POINT_COUNT = 3_000_000;

export interface LoadedPly {
  /** Origin-centered geometry; `color` attribute holds the current linear colours. */
  geometry: BufferGeometry;
  /** True when the source had no faces (render as points). */
  isPoints: boolean;
  vertexCount: number;
  /** Raw colour channels for the colour pipeline, or null if the file had none. */
  color: RawColor | null;
  /** Whether the *current* colour settings produce visible vertex colours. */
  hasColors: boolean;
  /** Rotation-safe bounding-sphere radius from the origin (for the camera fit). */
  radius: number;
  /** Axis-aligned size before centering, for display. */
  size: [number, number, number];
  warnings: string[];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Scan a PLY header (ASCII prefix) for the property names of the `vertex` element.
 * Cheap header-only peek so we can enable the 16-bit colour mapping only when the
 * file actually carries those channels (an unconditional custom mapping would fail
 * on files without them).
 */
function readVertexProperties(buffer: ArrayBuffer): Set<string> {
  const slice = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 65536));
  let text = '';
  for (let i = 0; i < slice.length; i++) text += String.fromCharCode(slice[i] ?? 0);
  const end = text.indexOf('end_header');
  const header = end >= 0 ? text.slice(0, end) : text;
  const props = new Set<string>();
  let inVertex = false;
  for (const raw of header.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('element vertex')) inVertex = true;
    else if (line.startsWith('element ')) inVertex = false;
    else if (inVertex && line.startsWith('property ') && !line.includes('list')) {
      const name = line.split(/\s+/).pop();
      if (name) props.add(name);
    }
  }
  return props;
}

/**
 * Pull the raw colour channels off a freshly-parsed geometry into a {@link RawColor}
 * (with cached highlight stats), then strip those attributes — the canonical `color`
 * attribute is rebuilt by the colour pipeline. Reads the 8-bit channel through
 * `getX/Y/Z` so a normalized byte attribute or a float colour attribute both work.
 */
function extractRawColor(geometry: BufferGeometry): RawColor | null {
  const c8 = geometry.getAttribute('color');
  const c16 = geometry.getAttribute('rgb16');
  let rgb8: Uint8Array | undefined;
  let rgb16: Uint16Array | undefined;

  if (c8) {
    const n = c8.count;
    rgb8 = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      rgb8[i * 3] = Math.round(clamp01(c8.getX(i)) * 255);
      rgb8[i * 3 + 1] = Math.round(clamp01(c8.getY(i)) * 255);
      rgb8[i * 3 + 2] = Math.round(clamp01(c8.getZ(i)) * 255);
    }
  }
  if (c16) {
    rgb16 = new Uint16Array(c16.array as ArrayLike<number>);
    geometry.deleteAttribute('rgb16');
  }
  return makeRawColor({ rgb8, rgb16 });
}

/**
 * Center the geometry on its axis-aligned bounding box (matching the CLI) and
 * return a rotation-safe radius: the farthest possible vertex distance from the
 * origin. Computed as |sphereCenter| + sphereRadius so it stays an upper bound
 * even when the optimal bounding sphere isn't centered exactly on the origin.
 */
function centerAndMeasure(geometry: BufferGeometry): { radius: number; size: [number, number, number] } {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const cx = (box.min.x + box.max.x) / 2;
  const cy = (box.min.y + box.max.y) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  const size: [number, number, number] = [
    box.max.x - box.min.x,
    box.max.y - box.min.y,
    box.max.z - box.min.z,
  ];
  geometry.translate(-cx, -cy, -cz);

  geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere!;
  const radius = sphere.center.length() + sphere.radius;
  return { radius, size };
}

/**
 * Recompute the geometry's `color` attribute from the raw channels under `settings`,
 * updating {@link LoadedPly.hasColors}. Mutates the existing colour buffer in place
 * when the size matches (cheap on brightness-slider drags). Returns the resolve info
 * (chosen source + gain) for the UI. No-op-safe when the file had no colour.
 */
export function applyColorSettings(loaded: LoadedPly, settings: ColorSettings): ColorResolveInfo {
  const existing = loaded.geometry.getAttribute('color')?.array;
  const reuse = existing instanceof Float32Array ? existing : undefined;
  const result = resolveColors(loaded.color, settings, reuse);

  if (result.colors) {
    const current = loaded.geometry.getAttribute('color');
    if (current && current.array === result.colors) {
      current.needsUpdate = true;
    } else {
      loaded.geometry.setAttribute('color', new Float32BufferAttribute(result.colors, 3));
    }
  }
  loaded.hasColors = result.effectiveHasColors;
  return result.info;
}

/**
 * Normalize a freshly-parsed PLY BufferGeometry into a {@link LoadedPly}. Throws
 * a user-facing Error for empty/degenerate geometry.
 */
export function normalizeGeometry(geometry: BufferGeometry): LoadedPly {
  const position = geometry.getAttribute('position');
  const vertexCount = position ? position.count : 0;
  if (!position || vertexCount === 0) {
    throw new Error('This PLY file has no vertices to render.');
  }

  const isPoints = geometry.getIndex() === null;
  const warnings: string[] = [];

  // Meshes need normals for the lit shader; points never do.
  if (!isPoints && !geometry.getAttribute('normal')) {
    geometry.computeVertexNormals();
  }

  const color = extractRawColor(geometry);
  if (!color) {
    warnings.push('No vertex colours found — using a neutral fill colour.');
  }

  const { radius, size } = centerAndMeasure(geometry);
  if (!(radius > 0) || !Number.isFinite(radius)) {
    throw new Error('This PLY file has zero size or invalid coordinates.');
  }

  const loaded: LoadedPly = {
    geometry,
    isPoints,
    vertexCount,
    color,
    hasColors: false,
    radius,
    size,
    warnings,
  };
  // Bake the default colour treatment (Auto) so the preview looks right immediately.
  applyColorSettings(loaded, DEFAULT_COLOR_SETTINGS);

  if (vertexCount > LARGE_POINT_COUNT) {
    const millions = (vertexCount / 1_000_000).toFixed(1);
    warnings.push(
      `Large model (${millions}M points) — preview and export may be slow on this device.`,
    );
  }

  return loaded;
}

/** Parse raw PLY bytes (ASCII or binary) into a normalized {@link LoadedPly}. */
export function parsePly(buffer: ArrayBuffer): LoadedPly {
  const props = readVertexProperties(buffer);
  const has16 = props.has('red16') && props.has('green16') && props.has('blue16');

  const loader = new PLYLoader();
  if (has16) {
    loader.setCustomPropertyNameMapping({ rgb16: ['red16', 'green16', 'blue16'] });
  }

  let geometry: BufferGeometry;
  try {
    geometry = loader.parse(buffer);
  } catch (cause) {
    throw new Error('This file could not be parsed as a PLY model.', { cause });
  }
  return normalizeGeometry(geometry);
}

/** Read a user-selected File and load it as a normalized {@link LoadedPly}. */
export async function loadPlyFromFile(file: File): Promise<LoadedPly> {
  const buffer = await file.arrayBuffer();
  return parsePly(buffer);
}
