// Interactive Three.js turntable preview (main thread).
//
// Owns the canonical, origin-centered geometry loaded from the PLY and renders it
// with OrbitControls for free inspection. A "lock to export camera" mode drives the
// camera along the exact deterministic turntable path (via the shared camera math)
// so the user can preview what the rendered video will show. The scene/material
// setup is shared with the render worker through `sceneBuilder.ts`.

import {
  Color,
  PerspectiveCamera,
  Vector3,
  WebGLRenderer,
  type Mesh,
  type Points,
  type PointsMaterial,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LoadedPly } from '../ply/load';
import {
  buildScene,
  configureRenderer,
  pointSize,
  setObjectColorState,
  type SceneObjects,
} from './sceneBuilder';
import {
  eyeForAngle,
  fitDistance,
  frameAngle,
  nearFar,
  orbitBasis,
  type Axis,
  type SpinDirection,
} from '../camera/turntable';

export interface PreviewCameraParams {
  axis: Axis;
  verticalFovDeg: number;
  margin: number;
  turns: number;
  direction: SpinDirection;
}

export const DEFAULT_CAMERA_PARAMS: PreviewCameraParams = {
  axis: 'z',
  verticalFovDeg: 60,
  margin: 1.5,
  turns: 1,
  direction: 'ccw',
};

/** Wall-clock seconds for one full loop when previewing the export camera. */
const EXPORT_PREVIEW_LOOP_SECONDS = 8;
/** Angle granularity for the locked preview orbit (purely visual smoothness). */
const EXPORT_PREVIEW_STEPS = 240;

export class TurntablePreview {
  private readonly renderer: WebGLRenderer;
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private readonly origin = new Vector3(0, 0, 0);

  private loaded: LoadedPly | null = null;
  private sceneObjects: SceneObjects | null = null;
  private params: PreviewCameraParams = { ...DEFAULT_CAMERA_PARAMS };
  private background = new Color('#ffffff');

  private exportLock = false;
  private lockStart = 0;
  private rafId = 0;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    configureRenderer(this.renderer);

    this.camera = new PerspectiveCamera(this.params.verticalFovDeg, 1, 0.1, 1000);
    this.camera.up.set(0, 0, 1);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.copy(this.origin);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(canvas);
    this.handleResize();

    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  /** Load a new model: rebuild the scene and refit the camera to frame it. */
  setModel(loaded: LoadedPly): void {
    this.disposeSceneObjects();
    this.loaded = loaded;
    this.sceneObjects = buildScene(loaded, {
      width: this.renderer.domElement.width,
      background: this.background,
    });
    this.refitCamera();
  }

  /** Update camera framing controls (axis / FoV / margin / spin) and refit. */
  setCameraParams(next: Partial<PreviewCameraParams>): void {
    this.params = { ...this.params, ...next };
    this.camera.fov = this.params.verticalFovDeg;
    this.refitCamera();
  }

  /** Lock the preview to the deterministic export orbit (disables free-look). */
  setExportCameraLock(enabled: boolean): void {
    this.exportLock = enabled;
    this.controls.enabled = !enabled;
    if (enabled) {
      this.lockStart = performance.now();
      // Tighten the depth range to match what the export path would use.
      if (this.loaded) {
        const distance = this.currentDistance();
        const { near, far } = nearFar(distance, this.loaded.radius);
        this.camera.near = near;
        this.camera.far = far;
        this.camera.updateProjectionMatrix();
      }
    } else {
      this.applyInteractiveClipping();
    }
  }

  /**
   * Re-sync the preview to the loaded model's current colour state after the colour
   * mode / brightness changed (`applyColorSettings` already rebaked the `color`
   * attribute). Toggles vertex colours on/off and re-uploads the buffer.
   */
  refreshColors(): void {
    if (!this.loaded || !this.sceneObjects) return;
    setObjectColorState(this.sceneObjects.object, this.loaded.hasColors);
  }

  setBackground(color: Color | string | number): void {
    this.background = new Color(color);
    if (this.sceneObjects) {
      this.sceneObjects.scene.background = this.background;
    }
  }

  get isExportCameraLocked(): boolean {
    return this.exportLock;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.disposeSceneObjects();
    this.renderer.dispose();
  }

  // --- internals -------------------------------------------------------------

  private aspect(): number {
    const { width, height } = this.renderer.domElement;
    return height > 0 ? width / height : 1;
  }

  private currentDistance(): number {
    if (!this.loaded) return 1;
    return fitDistance(this.loaded.radius, this.params.verticalFovDeg, this.aspect(), this.params.margin);
  }

  /** Reposition the camera at export frame 0 and set a comfortable depth range. */
  private refitCamera(): void {
    if (!this.loaded) return;
    const distance = this.currentDistance();
    const { up } = orbitBasis(this.params.axis, distance);
    const eye = eyeForAngle(this.params.axis, distance, 0);
    this.camera.up.set(up[0], up[1], up[2]);
    this.camera.position.set(eye[0], eye[1], eye[2]);
    this.camera.fov = this.params.verticalFovDeg;
    this.controls.target.copy(this.origin);
    this.applyInteractiveClipping();
    this.controls.update();
  }

  /** Generous near/far so free orbit + zoom never clips the model. */
  private applyInteractiveClipping(): void {
    if (!this.loaded) return;
    const distance = this.currentDistance();
    this.camera.near = Math.max(this.loaded.radius * 0.01, 0.01);
    this.camera.far = (distance + this.loaded.radius) * 6;
    this.camera.updateProjectionMatrix();
  }

  private handleResize(): void {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = this.aspect();
    this.camera.updateProjectionMatrix();
    // Point size follows the drawing-buffer width.
    if (this.sceneObjects && this.loaded?.isPoints) {
      const material = (this.sceneObjects.object as Points).material as PointsMaterial;
      material.size = pointSize(this.renderer.domElement.width);
    }
    if (this.loaded && !this.exportLock) this.applyInteractiveClipping();
  }

  private updateLockedCamera(): void {
    if (!this.loaded) return;
    const distance = this.currentDistance();
    const elapsed = (performance.now() - this.lockStart) / 1000;
    const t = (elapsed / EXPORT_PREVIEW_LOOP_SECONDS) % 1;
    const index = t * EXPORT_PREVIEW_STEPS;
    const angle = frameAngle(index, EXPORT_PREVIEW_STEPS, this.params.turns, this.params.direction);
    const { up } = orbitBasis(this.params.axis, distance);
    const eye = eyeForAngle(this.params.axis, distance, angle);
    this.camera.up.set(up[0], up[1], up[2]);
    this.camera.position.set(eye[0], eye[1], eye[2]);
    this.camera.lookAt(this.origin);
  }

  private loop(): void {
    if (this.disposed) return;
    if (this.exportLock) {
      this.updateLockedCamera();
    } else {
      this.controls.update();
    }
    if (this.sceneObjects) {
      this.renderer.render(this.sceneObjects.scene, this.camera);
    }
    this.rafId = requestAnimationFrame(this.loop);
  }

  private disposeSceneObjects(): void {
    this.sceneObjects?.dispose();
    this.sceneObjects = null;
  }
}

// Re-export the material's typing helper so callers needn't dig into three.
export type PreviewObject = Points | Mesh;
