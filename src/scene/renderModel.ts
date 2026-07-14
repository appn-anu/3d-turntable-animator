// Headless turntable renderer: draws deterministic export frames onto an
// OffscreenCanvas via a WebGLRenderer. Runs inside the render worker (Milestone 2)
// and shares the exact scene/material/colour setup with the interactive preview
// through `sceneBuilder.ts`, so the exported video matches what the user saw.
//
// The fit distance and near/far depend only on the geometry + output size, so they
// are computed once; only the eye position changes per frame.

import { Color, PerspectiveCamera, Vector3, WebGLRenderer } from 'three';
import { buildScene, configureRenderer, type SceneObjects } from './sceneBuilder';
import type { LoadedPly } from '../ply/load';
import {
  eyeForAngle,
  fitDistance,
  frameAngle,
  nearFar,
  orbitBasis,
  type Axis,
  type SpinDirection,
} from '../camera/turntable';

export interface RenderModelParams {
  width: number;
  height: number;
  axis: Axis;
  verticalFovDeg: number;
  margin: number;
  turns: number;
  direction: SpinDirection;
  background: Color | string | number;
}

export class TurntableRenderer {
  readonly canvas: OffscreenCanvas;
  private readonly renderer: WebGLRenderer;
  private readonly camera: PerspectiveCamera;
  private readonly scene: SceneObjects;
  private readonly origin = new Vector3(0, 0, 0);

  private readonly axis: Axis;
  private readonly turns: number;
  private readonly direction: SpinDirection;
  private readonly distance: number;

  constructor(loaded: LoadedPly, params: RenderModelParams) {
    const { width, height, axis, verticalFovDeg, margin, turns, direction } = params;
    this.axis = axis;
    this.turns = turns;
    this.direction = direction;

    this.canvas = new OffscreenCanvas(width, height);
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true });
    // Exact output pixels — no devicePixelRatio scaling for exports.
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    configureRenderer(this.renderer);

    this.scene = buildScene(loaded, { width, background: params.background });

    const aspect = height > 0 ? width / height : 1;
    this.distance = fitDistance(loaded.radius, verticalFovDeg, aspect, margin);
    const { near, far } = nearFar(this.distance, loaded.radius);
    const { up } = orbitBasis(axis, this.distance);

    this.camera = new PerspectiveCamera(verticalFovDeg, aspect, near, far);
    this.camera.up.set(up[0], up[1], up[2]);
    this.camera.updateProjectionMatrix();
  }

  /** Position the camera at frame `index` of `total` and render it. */
  renderFrame(index: number, total: number): void {
    const angle = frameAngle(index, total, this.turns, this.direction);
    const eye = eyeForAngle(this.axis, this.distance, angle);
    this.camera.position.set(eye[0], eye[1], eye[2]);
    this.camera.lookAt(this.origin);
    this.renderer.render(this.scene.scene, this.camera);
  }

  dispose(): void {
    this.scene.dispose();
    this.renderer.dispose();
  }
}
