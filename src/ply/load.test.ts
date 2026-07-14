import { describe, it, expect } from 'vitest';
import { parsePly, normalizeGeometry } from './load';

const encoder = new TextEncoder();
const toBuffer = (text: string): ArrayBuffer => {
  const bytes = encoder.encode(text);
  // Return a standalone ArrayBuffer (not a view over a larger pool).
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

const EMPTY_PLY = `ply
format ascii 1.0
element vertex 0
property float x
property float y
property float z
end_header
`;

describe('parsePly — point cloud', () => {
  const loaded = parsePly(toBuffer(POINTS_PLY));

  it('detects a point cloud (no faces)', () => {
    expect(loaded.isPoints).toBe(true);
    expect(loaded.vertexCount).toBe(3);
    expect(loaded.hasColors).toBe(true);
    expect(loaded.warnings).toHaveLength(0);
  });

  it('reports a positive, finite, rotation-safe radius', () => {
    expect(loaded.radius).toBeGreaterThan(0);
    expect(Number.isFinite(loaded.radius)).toBe(true);
    // Farthest centered vertex is sqrt(2) from the origin; radius is a safe upper bound.
    expect(loaded.radius).toBeGreaterThanOrEqual(Math.SQRT2 - 1e-6);
  });

  it('centers the geometry on the bbox center', () => {
    const pos = loaded.geometry.getAttribute('position');
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      minX = Math.min(minX, pos.getX(i));
      maxX = Math.max(maxX, pos.getX(i));
      minY = Math.min(minY, pos.getY(i));
      maxY = Math.max(maxY, pos.getY(i));
    }
    expect((minX + maxX) / 2).toBeCloseTo(0, 6);
    expect((minY + maxY) / 2).toBeCloseTo(0, 6);
  });

  it('decodes vertex colours to linear-space floats', () => {
    const color = loaded.geometry.getAttribute('color');
    // Pure red/green/blue at full 8-bit map to 1.0 in linear (sRGB EOTF of 1 == 1).
    expect(color.getX(0)).toBeCloseTo(1, 6); // red vertex R
    expect(color.getY(0)).toBeCloseTo(0, 6); // red vertex G
    expect(color.getZ(1)).toBeCloseTo(0, 6); // green vertex B
    // Values are floats in [0,1], not raw bytes.
    for (let i = 0; i < color.count; i++) {
      expect(color.getX(i)).toBeLessThanOrEqual(1);
      expect(color.getX(i)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('parsePly — mesh', () => {
  const loaded = parsePly(toBuffer(MESH_PLY));

  it('detects a mesh (has faces) and warns about missing colours', () => {
    expect(loaded.isPoints).toBe(false);
    expect(loaded.vertexCount).toBe(4);
    expect(loaded.hasColors).toBe(false);
    expect(loaded.warnings.join(' ')).toMatch(/colour/i);
  });

  it('computes vertex normals for the lit shader', () => {
    expect(loaded.geometry.getAttribute('normal')).toBeTruthy();
  });
});

describe('parsePly — error cases', () => {
  it('rejects a PLY with no vertices', () => {
    expect(() => parsePly(toBuffer(EMPTY_PLY))).toThrow(/no vertices/i);
  });

  it('rejects unparseable data', () => {
    expect(() => parsePly(toBuffer('this is not a ply file at all'))).toThrow();
  });
});

describe('normalizeGeometry — degenerate coordinates', () => {
  it('rejects a zero-size cloud (all vertices coincident)', () => {
    const degenerate = `ply
format ascii 1.0
element vertex 2
property float x
property float y
property float z
end_header
0 0 0
0 0 0
`;
    expect(() => parsePly(toBuffer(degenerate))).toThrow(/zero size|invalid/i);
  });

  it('is exposed for reuse alongside parsePly', () => {
    expect(typeof normalizeGeometry).toBe('function');
  });
});
