import { describe, it, expect } from 'vitest';
import {
  degToRad,
  radToDeg,
  rotateAboutAxis,
  orbitBasis,
  frameAngle,
  eyeForAngle,
  horizontalFovRad,
  fitDistance,
  nearFar,
  solveCameraFrame,
  type Axis,
  type Vec3,
} from './turntable';

const HALF_PI = Math.PI / 2;

function expectVecClose(actual: Vec3, expected: Vec3): void {
  for (let i = 0; i < 3; i++) {
    expect(actual[i]).toBeCloseTo(expected[i]!, 9);
  }
}

const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('degToRad / radToDeg', () => {
  it('round-trip', () => {
    expect(radToDeg(degToRad(60))).toBeCloseTo(60, 12);
    expect(degToRad(180)).toBeCloseTo(Math.PI, 12);
  });
});

describe('rotateAboutAxis', () => {
  it('angle 0 is the identity', () => {
    expectVecClose(rotateAboutAxis('z', 0, [1, 2, 3]), [1, 2, 3]);
  });

  it('z by +90deg sends +x -> +y and preserves the axis component', () => {
    expectVecClose(rotateAboutAxis('z', HALF_PI, [1, 0, 5]), [0, 1, 5]);
  });

  it('y by +90deg sends +x -> -z', () => {
    expectVecClose(rotateAboutAxis('y', HALF_PI, [1, 0, 0]), [0, 0, -1]);
  });

  it('x by +90deg sends +y -> +z', () => {
    expectVecClose(rotateAboutAxis('x', HALF_PI, [0, 1, 0]), [0, 0, 1]);
  });

  it('preserves vector length', () => {
    const v: Vec3 = [3, -4, 12];
    expect(length(rotateAboutAxis('y', 0.723, v))).toBeCloseTo(length(v), 9);
  });
});

describe('orbitBasis', () => {
  it('matches the CLI axis -> base_eye/up mapping', () => {
    expect(orbitBasis('x', 10)).toEqual({ baseEye: [0, 10, 0], up: [1, 0, 0] });
    expect(orbitBasis('y', 10)).toEqual({ baseEye: [0, 0, 10], up: [0, 1, 0] });
    expect(orbitBasis('z', 10)).toEqual({ baseEye: [10, 0, 0], up: [0, 0, 1] });
  });
});

describe('frameAngle', () => {
  it('is zero at frame 0', () => {
    expect(frameAngle(0, 120)).toBe(0);
  });

  it('ccw sweeps to a full turn at the wrap frame', () => {
    expect(frameAngle(120, 120)).toBeCloseTo(2 * Math.PI, 12);
  });

  it('cw is the negation of ccw', () => {
    expect(frameAngle(30, 120, 1, 'cw')).toBeCloseTo(-frameAngle(30, 120, 1, 'ccw'), 12);
  });

  it('turns multiplies the total sweep', () => {
    expect(frameAngle(120, 120, 3)).toBeCloseTo(6 * Math.PI, 12);
  });

  it('guards against a zero frame count', () => {
    expect(frameAngle(0, 0)).toBe(0);
  });
});

describe('eyeForAngle', () => {
  const axes: Axis[] = ['x', 'y', 'z'];

  it('at angle 0 equals the base eye', () => {
    for (const axis of axes) {
      expectVecClose(eyeForAngle(axis, 7, 0), orbitBasis(axis, 7).baseEye);
    }
  });

  it('keeps the eye at the orbit radius and perpendicular to up', () => {
    for (const axis of axes) {
      const { up } = orbitBasis(axis, 7);
      for (const angle of [0.1, 1, 2.5, 4, 6]) {
        const eye = eyeForAngle(axis, 7, angle);
        expect(length(eye)).toBeCloseTo(7, 9);
        // Orbit plane is perpendicular to the up/rotation axis.
        expect(dot(eye, up)).toBeCloseTo(0, 9);
      }
    }
  });

  it('z-axis quarter turn moves +x eye into +y', () => {
    expectVecClose(eyeForAngle('z', 5, HALF_PI), [0, 5, 0]);
  });
});

describe('horizontalFovRad', () => {
  it('equals the vertical FoV at square aspect', () => {
    const vfov = degToRad(60);
    expect(horizontalFovRad(vfov, 1)).toBeCloseTo(vfov, 12);
  });

  it('is wider than vertical for landscape aspect', () => {
    const vfov = degToRad(60);
    expect(horizontalFovRad(vfov, 16 / 9)).toBeGreaterThan(vfov);
  });

  it('is narrower than vertical for portrait aspect', () => {
    const vfov = degToRad(60);
    expect(horizontalFovRad(vfov, 9 / 16)).toBeLessThan(vfov);
  });
});

describe('fitDistance', () => {
  it('at square aspect, the sphere subtends exactly the vertical FoV (before margin)', () => {
    const radius = 2;
    const vfovDeg = 60;
    const d = fitDistance(radius, vfovDeg, 1, 1);
    // Half-angle subtended by the sphere == half the vertical FoV.
    expect(Math.asin(radius / d)).toBeCloseTo(degToRad(vfovDeg) / 2, 9);
  });

  it('scales linearly with margin', () => {
    const base = fitDistance(2, 60, 1, 1);
    expect(fitDistance(2, 60, 1, 1.5)).toBeCloseTo(base * 1.5, 9);
  });

  it('scales linearly with radius', () => {
    const base = fitDistance(1, 60, 1.3, 1.5);
    expect(fitDistance(4, 60, 1.3, 1.5)).toBeCloseTo(base * 4, 9);
  });

  it('portrait output pushes the camera back farther than landscape (horizontal-limited)', () => {
    const landscape = fitDistance(2, 60, 16 / 9, 1.5);
    const portrait = fitDistance(2, 60, 9 / 16, 1.5);
    expect(portrait).toBeGreaterThan(landscape);
  });

  it('the sphere fits within both FoVs at the computed distance (with margin slack)', () => {
    const radius = 2;
    const vfovDeg = 50;
    const aspect = 9 / 16; // portrait, horizontally limited
    const margin = 1.5;
    const d = fitDistance(radius, vfovDeg, aspect, margin);
    const vfov = degToRad(vfovDeg);
    const hfov = horizontalFovRad(vfov, aspect);
    const subtended = Math.asin(radius / d);
    expect(subtended).toBeLessThanOrEqual(vfov / 2 + 1e-9);
    expect(subtended).toBeLessThanOrEqual(hfov / 2 + 1e-9);
  });
});

describe('nearFar', () => {
  it('brackets the sphere in depth with padding', () => {
    const { near, far } = nearFar(10, 2, 1.1);
    expect(far).toBeCloseTo(10 + 2.2, 9);
    expect(near).toBeCloseTo(10 - 2.2, 9);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(far);
  });

  it('clamps near strictly positive even when padding would cross the origin', () => {
    // Contrived: radius larger than distance (never happens with margin>=1, but guard anyway).
    const { near } = nearFar(1, 5, 1.1);
    expect(near).toBeGreaterThan(0);
  });
});

describe('solveCameraFrame', () => {
  const params = {
    axis: 'z' as Axis,
    radius: 3,
    width: 1080,
    height: 1080,
    verticalFovDeg: 60,
    margin: 1.5,
  };

  it('frame 0 looks at the origin from the base eye along the correct axis', () => {
    const f = solveCameraFrame(params, 0, 120);
    expect(f.center).toEqual([0, 0, 0]);
    expect(f.up).toEqual([0, 0, 1]);
    expect(f.aspect).toBeCloseTo(1, 12);
    expect(f.fovDeg).toBe(60);
    expect(length(f.eye)).toBeCloseTo(f.distance, 9);
    expectVecClose(f.eye, [f.distance, 0, 0]);
  });

  it('near < distance < far', () => {
    const f = solveCameraFrame(params, 0, 120);
    expect(f.near).toBeLessThan(f.distance);
    expect(f.distance).toBeLessThan(f.far);
    expect(f.near).toBeGreaterThan(0);
  });

  it('keeps a constant orbit radius across the loop', () => {
    const a = solveCameraFrame(params, 17, 120);
    const b = solveCameraFrame(params, 88, 120);
    expect(length(a.eye)).toBeCloseTo(length(b.eye), 9);
    expect(a.distance).toBeCloseTo(b.distance, 12);
  });
});
