// PLY loading + normalization.
//
// Wraps Three's PLYLoader and produces a canonical, preview-ready geometry that
// matches the reference CLI's conventions:
//   - No faces (geometry has no index) -> render as THREE.Points; else a lit mesh.
//   - Centered at the origin via its axis-aligned bounding box (CLI centers on the
//     bbox center so the turntable spin is clean).
//   - Vertex colours (stored as authored sRGB) are decoded to linear so a
//     color-managed, sRGB-output renderer reproduces the authored bytes (parity
//     with the CLI's unlit point shader / `sRGB_color` lit material).
//
// Also reports a rotation-safe bounding-sphere radius (measured from the origin,
// so it stays valid at every turntable angle) for the camera fit (gpt #5), plus
// warnings for the edge cases the UI should surface.

import { BufferGeometry, Float32BufferAttribute } from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

/** Warn (not fail) above this many points — decimation is a post-v1 concern. */
export const LARGE_POINT_COUNT = 3_000_000;

export interface LoadedPly {
  /** Origin-centered geometry; colours decoded to linear-space float if present. */
  geometry: BufferGeometry;
  /** True when the source had no faces (render as points). */
  isPoints: boolean;
  vertexCount: number;
  hasColors: boolean;
  /** Rotation-safe bounding-sphere radius from the origin (for the camera fit). */
  radius: number;
  /** Axis-aligned size before centering, for display. */
  size: [number, number, number];
  warnings: string[];
}

/** Single-channel sRGB -> linear (matches the standard sRGB EOTF). */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Replace a geometry's `color` attribute (authored sRGB) with a linear-space
 * Float32 attribute, reading through `getX/Y/Z` so normalized 8-bit colours are
 * handled correctly. No-op when there is no colour attribute.
 */
function decodeVertexColorsToLinear(geometry: BufferGeometry): boolean {
  const color = geometry.getAttribute('color');
  if (!color) return false;
  const count = color.count;
  const linear = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    linear[i * 3] = srgbToLinear(color.getX(i));
    linear[i * 3 + 1] = srgbToLinear(color.getY(i));
    linear[i * 3 + 2] = srgbToLinear(color.getZ(i));
  }
  geometry.setAttribute('color', new Float32BufferAttribute(linear, 3));
  return true;
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

  const hasColors = decodeVertexColorsToLinear(geometry);
  if (!hasColors) {
    warnings.push('No vertex colours found — using a neutral fill colour.');
  }

  const { radius, size } = centerAndMeasure(geometry);
  if (!(radius > 0) || !Number.isFinite(radius)) {
    throw new Error('This PLY file has zero size or invalid coordinates.');
  }

  if (vertexCount > LARGE_POINT_COUNT) {
    const millions = (vertexCount / 1_000_000).toFixed(1);
    warnings.push(
      `Large model (${millions}M points) — preview and export may be slow on this device.`,
    );
  }

  return { geometry, isPoints, vertexCount, hasColors, radius, size, warnings };
}

/** Parse raw PLY bytes (ASCII or binary) into a normalized {@link LoadedPly}. */
export function parsePly(buffer: ArrayBuffer): LoadedPly {
  let geometry: BufferGeometry;
  try {
    geometry = new PLYLoader().parse(buffer);
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
