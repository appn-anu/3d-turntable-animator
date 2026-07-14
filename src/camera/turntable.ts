// Framework-agnostic turntable camera math.
//
// Ported from the reference CLI `python-CLI/render_turntable.py` (rotate_x/y/z,
// the axis -> base_eye/up/rotation mapping, `eye = R(angle) @ base_eye`, and the
// vertical-FoV distance), then upgraded per gpt #5 to a *bounding-sphere* fit that
// is safe at every turntable angle, an aspect-derived horizontal FoV for non-square
// output, and dynamic near/far from the scene bounds.
//
// Everything here is pure and dependency-free so it can be unit-tested in Node and
// reused by both the Three.js preview (main thread) and the render worker.

export type Axis = 'x' | 'y' | 'z';
export type SpinDirection = 'cw' | 'ccw';
export type Vec3 = readonly [number, number, number];

export const degToRad = (deg: number): number => (deg * Math.PI) / 180;
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

/**
 * Rotate a vector about a principal axis (right-handed), matching the CLI's
 * rotate_x / rotate_y / rotate_z matrices multiplied on the left of the vector.
 */
export function rotateAboutAxis(axis: Axis, angle: number, v: Vec3): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const [x, y, z] = v;
  switch (axis) {
    case 'x':
      // [[1,0,0],[0,c,-s],[0,s,c]]
      return [x, c * y - s * z, s * y + c * z];
    case 'y':
      // [[c,0,s],[0,1,0],[-s,0,c]]
      return [c * x + s * z, y, -s * x + c * z];
    case 'z':
      // [[c,-s,0],[s,c,0],[0,0,1]]
      return [c * x - s * y, s * x + c * y, z];
  }
}

export interface OrbitBasis {
  /** Eye position at orbit angle 0, `distance` from the origin. */
  baseEye: Vec3;
  /** Camera up vector (the rotation axis), constant through the orbit. */
  up: Vec3;
}

/**
 * Axis -> starting eye direction and up vector, matching the CLI so the object
 * stays roughly upright in frame. The eye orbits in the plane perpendicular to
 * `up`, which is the rotation axis itself.
 */
export function orbitBasis(axis: Axis, distance: number): OrbitBasis {
  switch (axis) {
    case 'x':
      return { baseEye: [0, distance, 0], up: [1, 0, 0] };
    case 'y':
      return { baseEye: [0, 0, distance], up: [0, 1, 0] };
    case 'z':
      return { baseEye: [distance, 0, 0], up: [0, 0, 1] };
  }
}

/**
 * Signed orbit angle (radians) for a frame. `ccw` matches the CLI's positive
 * `2*pi*i/n` sweep; `cw` reverses it. `turns` (integer for a seamless loop)
 * multiplies the total sweep.
 */
export function frameAngle(
  index: number,
  frameCount: number,
  turns = 1,
  direction: SpinDirection = 'ccw',
): number {
  if (frameCount <= 0) return 0;
  const sign = direction === 'cw' ? -1 : 1;
  return sign * 2 * Math.PI * turns * (index / frameCount);
}

/** Eye position for an arbitrary orbit angle. */
export function eyeForAngle(axis: Axis, distance: number, angle: number): Vec3 {
  return rotateAboutAxis(axis, angle, orbitBasis(axis, distance).baseEye);
}

/** Horizontal FoV (radians) implied by a vertical FoV and an aspect ratio. */
export function horizontalFovRad(verticalFovRad: number, aspect: number): number {
  return 2 * Math.atan(Math.tan(verticalFovRad / 2) * aspect);
}

/**
 * Bounding-sphere fit distance (gpt #5). Places the camera so a sphere of the
 * given radius (centered at the origin) fits within BOTH the vertical and the
 * aspect-derived horizontal FoV — safe at every turntable angle — then scales by
 * the user framing `margin`. `aspect` is width / height.
 */
export function fitDistance(
  radius: number,
  verticalFovDeg: number,
  aspect: number,
  margin: number,
): number {
  const r = Math.max(radius, Number.EPSILON);
  const vfov = degToRad(verticalFovDeg);
  const hfov = horizontalFovRad(vfov, aspect);
  const distV = r / Math.sin(vfov / 2);
  const distH = r / Math.sin(hfov / 2);
  // The tighter (smaller) FoV dimension yields the larger required distance.
  return Math.max(distV, distH) * margin;
}

export interface NearFar {
  near: number;
  far: number;
}

/**
 * Dynamic near/far planes from the scene bounds (gpt #5): the orbiting camera is
 * always `distance` from the origin, so the sphere spans `[distance - r, distance
 * + r]` in depth. `padding` (>= 1) adds a little slack; near is clamped strictly
 * positive.
 */
export function nearFar(distance: number, radius: number, padding = 1.1): NearFar {
  const pad = Math.max(radius, 0) * padding;
  const near = Math.max(distance - pad, distance * 1e-3);
  const far = distance + pad;
  return { near, far };
}

export interface SolvedCameraFrame {
  eye: Vec3;
  up: Vec3;
  center: Vec3;
  /** Vertical FoV in degrees (Three.js PerspectiveCamera convention). */
  fovDeg: number;
  near: number;
  far: number;
  aspect: number;
  distance: number;
}

export interface TurntableCameraParams {
  axis: Axis;
  /** Bounding-sphere radius of the (origin-centered) geometry. */
  radius: number;
  width: number;
  height: number;
  /** Vertical field of view in degrees (matches the CLI `--fov`). */
  verticalFovDeg: number;
  /** Framing margin around the object (CLI `--margin`, 1.1-3.0, default 1.5). */
  margin: number;
  turns?: number;
  direction?: SpinDirection;
}

/**
 * One-stop solve for a single frame: everything a PerspectiveCamera needs. The
 * fit distance and near/far only depend on the geometry + output, so callers that
 * orbit many frames can hoist {@link fitDistance} / {@link nearFar} and only recompute
 * {@link eyeForAngle} per frame; this convenience recomputes them for clarity.
 */
export function solveCameraFrame(
  params: TurntableCameraParams,
  index: number,
  frameCount: number,
): SolvedCameraFrame {
  const { axis, radius, width, height, verticalFovDeg, margin } = params;
  const aspect = width / height;
  const distance = fitDistance(radius, verticalFovDeg, aspect, margin);
  const angle = frameAngle(index, frameCount, params.turns ?? 1, params.direction ?? 'ccw');
  const { up } = orbitBasis(axis, distance);
  const { near, far } = nearFar(distance, radius);
  return {
    eye: eyeForAngle(axis, distance, angle),
    up,
    center: [0, 0, 0],
    fovDeg: verticalFovDeg,
    near,
    far,
    aspect,
    distance,
  };
}
