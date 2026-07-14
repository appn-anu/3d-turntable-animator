import { describe, it, expect } from 'vitest';
import { parsePly } from '../ply/load';
import {
  extractExportGeometry,
  rebuildGeometry,
  estimateExportBytes,
} from './exportGeometry';

const encoder = new TextEncoder();
const toBuffer = (text: string): ArrayBuffer => {
  const bytes = encoder.encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const POINTS_PLY = `ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
end_header
0 0 0 255 0 0
2 0 0 0 255 0
0 2 0 0 0 255
`;

const MESH_PLY = `ply
format ascii 1.0
element vertex 4
property float x
property float y
property float z
element face 2
property list uchar int vertex_indices
end_header
0 0 0
1 0 0
1 1 0
0 1 0
3 0 1 2
3 0 2 3
`;

describe('extractExportGeometry — point cloud', () => {
  it('copies positions + colours and lists their buffers for transfer', () => {
    const loaded = parsePly(toBuffer(POINTS_PLY));
    const { payload, transfer } = extractExportGeometry(loaded);

    expect(payload.isPoints).toBe(true);
    expect(payload.hasColors).toBe(true);
    expect(payload.vertexCount).toBe(3);
    expect(payload.positions).toHaveLength(9);
    expect(payload.colors).toHaveLength(9);
    expect(payload.indices).toBeNull();

    expect(transfer).toContain(payload.positions.buffer);
    expect(transfer).toContain(payload.colors!.buffer);
    expect(transfer).toHaveLength(2);
  });

  it('does NOT detach or alias the preview geometry buffers (gpt #2)', () => {
    const loaded = parsePly(toBuffer(POINTS_PLY));
    const source = loaded.geometry.getAttribute('position');
    const { payload } = extractExportGeometry(loaded);

    // Different backing buffers.
    expect(payload.positions.buffer).not.toBe(source.array.buffer);
    // Mutating the export copy leaves the canonical geometry intact.
    payload.positions[0] = 999;
    expect(source.getX(0)).not.toBe(999);
    // Source buffer is still live (not neutered by a transfer).
    expect(source.array.byteLength).toBeGreaterThan(0);
  });
});

describe('extractExportGeometry — mesh', () => {
  it('copies indices and includes them in the transfer list', () => {
    const loaded = parsePly(toBuffer(MESH_PLY));
    const { payload, transfer } = extractExportGeometry(loaded);

    expect(payload.isPoints).toBe(false);
    expect(payload.indices).not.toBeNull();
    expect(payload.indices).toHaveLength(6); // two triangles
    expect(payload.colors).toBeNull();
    expect(transfer).toContain(payload.indices!.buffer);
  });
});

describe('estimateExportBytes', () => {
  it('accounts for positions and colours', () => {
    const loaded = parsePly(toBuffer(POINTS_PLY));
    // 3 verts * 3 comps * 4 bytes, twice (pos + colour).
    expect(estimateExportBytes(loaded)).toBe(3 * 3 * 4 * 2);
  });

  it('rejects a model over the memory cap', () => {
    const loaded = parsePly(toBuffer(POINTS_PLY));
    // Force the position count sky-high so the guard trips, without allocating.
    const position = loaded.geometry.getAttribute('position');
    Object.defineProperty(position, 'count', { value: 1e9, configurable: true });
    expect(() => extractExportGeometry(loaded)).toThrow(/memory|smaller model/i);
  });
});

describe('rebuildGeometry round-trip', () => {
  it('reconstructs an equivalent point cloud', () => {
    const loaded = parsePly(toBuffer(POINTS_PLY));
    const { payload } = extractExportGeometry(loaded);
    const rebuilt = rebuildGeometry(payload);

    expect(rebuilt.isPoints).toBe(true);
    expect(rebuilt.hasColors).toBe(true);
    expect(rebuilt.vertexCount).toBe(3);
    expect(rebuilt.radius).toBeCloseTo(loaded.radius, 6);

    const src = loaded.geometry.getAttribute('position');
    const dst = rebuilt.geometry.getAttribute('position');
    for (let i = 0; i < src.count; i++) {
      expect(dst.getX(i)).toBeCloseTo(src.getX(i), 6);
      expect(dst.getY(i)).toBeCloseTo(src.getY(i), 6);
      expect(dst.getZ(i)).toBeCloseTo(src.getZ(i), 6);
    }
  });

  it('reconstructs mesh indices', () => {
    const loaded = parsePly(toBuffer(MESH_PLY));
    const { payload } = extractExportGeometry(loaded);
    const rebuilt = rebuildGeometry(payload);
    expect(rebuilt.isPoints).toBe(false);
    expect(rebuilt.geometry.getIndex()).not.toBeNull();
    expect(rebuilt.geometry.getIndex()!.count).toBe(6);
  });
});
