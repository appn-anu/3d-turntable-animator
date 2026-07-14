// Geometry ownership across the main-thread / worker boundary (gpt #2).
//
// The preview holds the *canonical* geometry and must keep owning it — if we
// transferred its ArrayBuffers to the render worker, the preview's attributes
// would be detached and the on-screen model would vanish. So on export we make an
// independent COPY of each attribute and transfer the copy's buffers; the preview
// is untouched. A memory sanity-check guards against copying a pathologically
// large model.
//
// Both `extractExportGeometry` (main thread) and `rebuildGeometry` (worker) are
// pure — no WebGL — so the round trip is unit-tested.

import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from 'three';
import type { LoadedPly } from '../ply/load';

/** Refuse to copy more than this many bytes of geometry (soft guard, ~large 4K cloud). */
export const MAX_EXPORT_BYTES = 768 * 1024 * 1024;

export interface ExportGeometryPayload {
  /** Independent copy of the vertex positions (xyz, length = vertexCount*3). */
  positions: Float32Array;
  /** Independent copy of linear-space vertex colours, or null. */
  colors: Float32Array | null;
  /** Independent copy of face indices for meshes, or null for point clouds. */
  indices: Uint32Array | null;
  vertexCount: number;
  isPoints: boolean;
  hasColors: boolean;
  radius: number;
  size: [number, number, number];
}

export interface ExportGeometryMessage {
  payload: ExportGeometryPayload;
  /** ArrayBuffers of the COPIES, to hand to `postMessage(msg, transfer)`. */
  transfer: ArrayBuffer[];
}

/** Bytes the export copy will allocate (positions + colours + indices). */
export function estimateExportBytes(loaded: LoadedPly): number {
  const position = loaded.geometry.getAttribute('position');
  const color = loaded.geometry.getAttribute('color');
  const index = loaded.geometry.getIndex();
  const n = position ? position.count : 0;
  let bytes = n * 3 * Float32Array.BYTES_PER_ELEMENT; // positions
  if (color) bytes += n * 3 * Float32Array.BYTES_PER_ELEMENT; // colours
  if (index) bytes += index.count * Uint32Array.BYTES_PER_ELEMENT; // indices
  return bytes;
}

/**
 * Produce a transferable copy of the canonical geometry without detaching the
 * preview's buffers. `new Float32Array(source)` / `new Uint32Array(source)` always
 * allocate a fresh buffer, so the returned arrays are fully independent.
 */
export function extractExportGeometry(loaded: LoadedPly): ExportGeometryMessage {
  const bytes = estimateExportBytes(loaded);
  if (bytes > MAX_EXPORT_BYTES) {
    const mb = Math.round(bytes / (1024 * 1024));
    throw new Error(
      `This model needs ~${mb} MB to export, which may exceed available memory. ` +
        `Try a smaller model.`,
    );
  }

  const position = loaded.geometry.getAttribute('position');
  if (!position) {
    throw new Error('Cannot export: geometry has no positions.');
  }
  const positions = new Float32Array(position.array);

  const colorAttr = loaded.geometry.getAttribute('color');
  const colors = colorAttr ? new Float32Array(colorAttr.array) : null;

  const indexAttr = loaded.geometry.getIndex();
  const indices = indexAttr ? new Uint32Array(indexAttr.array) : null;

  const payload: ExportGeometryPayload = {
    positions,
    colors,
    indices,
    vertexCount: position.count,
    isPoints: loaded.isPoints,
    hasColors: loaded.hasColors,
    radius: loaded.radius,
    size: loaded.size,
  };

  const transfer: ArrayBuffer[] = [positions.buffer];
  if (colors) transfer.push(colors.buffer);
  if (indices) transfer.push(indices.buffer);

  return { payload, transfer };
}

/**
 * Rebuild a {@link LoadedPly} from a transferred payload (worker side, M2). The
 * geometry is already origin-centered with linear colours, so no re-normalization
 * is needed — just re-wrap the buffers as attributes.
 */
export function rebuildGeometry(payload: ExportGeometryPayload): LoadedPly {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(payload.positions, 3));
  if (payload.colors) {
    geometry.setAttribute('color', new Float32BufferAttribute(payload.colors, 3));
  }
  if (payload.indices) {
    geometry.setIndex(new Uint32BufferAttribute(payload.indices, 1));
  }
  geometry.computeBoundingSphere();
  return {
    geometry,
    isPoints: payload.isPoints,
    vertexCount: payload.vertexCount,
    hasColors: payload.hasColors,
    radius: payload.radius,
    size: payload.size,
    warnings: [],
  };
}
