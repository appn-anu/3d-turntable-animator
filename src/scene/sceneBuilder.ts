// Shared scene construction — used by BOTH the interactive preview (main thread)
// and the render worker (M2, OffscreenCanvas). Keeping the material/light/colour
// setup in one place guarantees the exported video looks exactly like the preview.
//
// Colour pipeline: the loader (`src/ply/load.ts`) has already decoded authored
// sRGB vertex colours to linear space, so we run a normal color-managed renderer
// with sRGB output and no tone mapping; the round trip reproduces the authored
// bytes (parity with the CLI's unlit point shader / `sRGB_color` lit material).

import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  NoToneMapping,
  Points,
  PointsMaterial,
  Scene,
  SRGBColorSpace,
  type WebGLRenderer,
} from 'three';
import type { LoadedPly } from '../ply/load';

/** Point diameter in pixels: clamp(width / 320, 2, 5) — matches the CLI. */
export function pointSize(width: number): number {
  return Math.max(2, Math.min(5, width / 320));
}

/** Apply the shared colour pipeline to any renderer (main-thread or worker). */
export function configureRenderer(renderer: WebGLRenderer): void {
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
}

/** Neutral fill colour (sRGB) for geometry that carries no vertex colours. */
const POINTS_FALLBACK = 0x9aa7b3;
const MESH_FALLBACK = 0xcfcfcf;

export interface SceneObjects {
  scene: Scene;
  object: Points | Mesh;
  /** Free GPU resources (geometry + material). */
  dispose(): void;
}

export interface BuildSceneOptions {
  /** Render-target width in pixels, used for the point-size heuristic. */
  width: number;
  /** Background colour (any THREE.Color-compatible value). Default white. */
  background?: Color | string | number;
}

/**
 * Build a ready-to-render scene from a normalized {@link LoadedPly}: the Points
 * or lit Mesh plus, for meshes, a key/fill/ambient light rig approximating the
 * CLI's directional sun. The geometry is used as-is (already origin-centered with
 * linear colours); callers own its lifetime via {@link SceneObjects.dispose}.
 */
export function buildScene(loaded: LoadedPly, options: BuildSceneOptions): SceneObjects {
  const scene = new Scene();
  scene.background = new Color(options.background ?? '#ffffff');

  const object = loaded.isPoints
    ? buildPoints(loaded.geometry, loaded.hasColors, options.width)
    : buildMesh(loaded.geometry, loaded.hasColors);
  scene.add(object);

  if (!loaded.isPoints) {
    addMeshLights(scene);
  }

  return {
    scene,
    object,
    dispose() {
      object.geometry.dispose();
      const material = object.material;
      if (Array.isArray(material)) {
        material.forEach((m) => m.dispose());
      } else {
        material.dispose();
      }
    },
  };
}

function buildPoints(geometry: BufferGeometry, hasColors: boolean, width: number): Points {
  const material = new PointsMaterial({
    size: pointSize(width),
    sizeAttenuation: false,
    vertexColors: hasColors,
    color: hasColors ? 0xffffff : POINTS_FALLBACK,
  });
  return new Points(geometry, material);
}

function buildMesh(geometry: BufferGeometry, hasColors: boolean): Mesh {
  const material = new MeshStandardMaterial({
    vertexColors: hasColors,
    color: hasColors ? 0xffffff : MESH_FALLBACK,
    roughness: 0.85,
    metalness: 0.0,
  });
  return new Mesh(geometry, material);
}

/**
 * Key directional light from the CLI's sun direction [0.5, 1, 1] plus a hemisphere
 * + ambient fill so unlit backsides don't read as pure black. Intensities are in
 * the physically-based range (renderer default since three r155); final values are
 * confirmed in the Milestone 3 visual-parity pass.
 */
function addMeshLights(scene: Scene): void {
  const key = new DirectionalLight(0xffffff, 3.0);
  key.position.set(0.5, 1.0, 1.0);
  scene.add(key);
  scene.add(new HemisphereLight(0xffffff, 0x404040, 1.0));
  scene.add(new AmbientLight(0xffffff, 0.3));
}
