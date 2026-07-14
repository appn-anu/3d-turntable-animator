# Turntable Web App - Client-Side Architecture Plan

> Status: v3 - minimal first-build direction (supersedes v2 for implementation)  
> Scope: one-page, offline-capable, client-side-only PWA. MP4-only output via WebCodecs.  
> v3 change: drop GIF and ffmpeg.wasm from the first build; deploy as a GitHub Pages static site.

---

## Review notes (v3)

The v2 plan kept two secondary paths in scope: GIF output via `gifenc`, and an ffmpeg.wasm fallback for browsers without H.264 `VideoEncoder`. Both are useful, but both add complexity that delays the core bet: a streaming WebCodecs MP4 pipeline running entirely in the browser.

For the first build we are removing both. This means:

- **MP4 only.** Users who need a GIF can convert the MP4 with an external tool. A GIF option can be revisited once the MP4 pipeline is proven.
- **WebCodecs only.** No ffmpeg.wasm, no OPFS frame staging, no fallback worker. If a browser cannot encode H.264 with `VideoEncoder`, the app shows a clear "not supported" message.
- **GitHub Pages deployment.** The app is static after `vite build`, so it can be served directly from GitHub Pages with a GitHub Actions deploy workflow.

This cuts the first implementation down to: upload PLY → preview → render+encode MP4 in a worker → download. The service worker/PWA caching layer also becomes much smaller because there is no multi-megabyte fallback WASM to lazy-load.

Fidelity notes carried over from v2:

- The CLI's `scale=` filter is a no-op; render at the requested size.
- `yuv420p` requires even dimensions; the form rounds width/height to even numbers.
- Vertical FoV, right-handed coordinate system, and explicit eye/up/lookAt from the CLI map cleanly to Three.js.

---

## Goals

- Convert the current CLI workflow (`render_turntable.py`) into a single-page web app.
- Work offline after first load (PWA).
- Render the preview and final frames entirely in the browser.
- Encode MP4 in the browser via WebCodecs `VideoEncoder` + a pure-JS MP4 muxer.
- Keep all options exposed on one page.
- Show a progress bar during the combined render+encode pass.
- Deploy automatically to GitHub Pages on every push to `main`.

---

## Non-goals

- Pixel-perfect reproduction of Open3D/Filament output.
- Supporting every browser equally on day one.
- GIF output, PNG-sequence export, or any other format in v1.
- Server-side rendering, queues, or persistence.
- Multi-user concurrency or account management.
- An ffmpeg.wasm fallback for browsers without WebCodecs H.264.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ Main thread - PWA shell                                        │
│ - Service worker caches static assets (JS, fonts)               │
│ - One-page UI: upload, parameter form, progress, download      │
│ - Three.js interactive preview (free orbit/zoom)               │
└───────────────────────────┬────────────────────────────────────┘
                            │ transfer geometry buffers + params
                            ▼
┌────────────────────────────────────────────────────────────────┐
│ Render worker (OffscreenCanvas) - streaming MP4 pipeline       │
│                                                                │
│   for each frame i:                                            │
│     render deterministic orbit camera frame (Three.js)         │
│     ├─► VideoFrame ─► WebCodecs VideoEncoder ─► MP4 muxer    │
│     post progress (i / n_frames)                               │
│                                                                │
│   finalize ─► MP4 blob ─► main thread ─► download link         │
└────────────────────────────────────────────────────────────────┘
```

Render and encode are a single streaming loop in one worker: each frame is handed to the encoder and dropped before the next frame is rendered. At 1280x1280, raw RGBA is ~6.5 MB/frame, so 360 buffered frames would be ~2.4 GB; streamed, peak memory is a handful of frames plus the encoder queue.

---

## Component responsibilities

### 1. Main thread / PWA shell

- Registers a service worker that caches the app bundle, Three.js, and the muxer. With ffmpeg.wasm removed, the cache is small (a few hundred KB) and can be precached at install.
- Hosts the one-page UI:
  - PLY file upload (drag/drop or picker), parsed with `THREE.PLYLoader` (handles ASCII and binary; no faces means point cloud, rendered as `THREE.Points`).
  - Controls for width/height, background, axis, duration, fps, fov, margin.
  - A Three.js canvas for interactive preview (free orbit), plus a "preview export camera" toggle that locks the camera to the deterministic turntable path.
  - Progress bar and download button.
- Spawns the render worker, transferring the parsed geometry buffers.
- Receives progress messages; creates a blob URL from the returned MP4.
- Surfaces `VideoEncoder.isConfigSupported()` failures with a clear "this browser cannot encode MP4" message.

### 2. Render worker - streaming render + encode

- Rebuilds the scene from transferred buffers; renders to an `OffscreenCanvas` so long renders never jank the UI.
- Centers geometry and computes camera distance with the same math as the CLI (see "Fidelity notes").
- Per frame: position the camera on the orbit, render, wrap the canvas in a `VideoFrame`, and feed it to `VideoEncoder`. Throttle on `encodeQueueSize` for backpressure.
- MP4: `VideoEncoder` with an `avc1.*` codec string at the user's fps, muxed by mediabunny.
- Posts progress after every frame (or every N frames); returns the final MP4 blob via transfer.

---

## Frame flow

1. **Upload** - user drops a PLY; main thread parses it, centers it via axis-aligned bbox (same as CLI), and populates the preview.
2. **Preview** - Three.js renders with vertex colours; camera is free by default, with a toggle to preview the exact export orbit. Parameter changes update the preview live where feasible.
3. **Render start** - main thread validates inputs (rounding dimensions to even), computes `n_frames = round(duration * fps)` and `distance = (max_size / (2 * tan(fov / 2))) * margin`, checks `VideoEncoder` support, and transfers geometry + params to the render worker.
4. **Streaming render+encode** - the worker loops over frames as described above, posting progress. Only MP4 is produced.
5. **Download** - worker returns the blob; main thread creates a blob URL and enables the download link. Optional: auto-trigger download.
6. **Cleanup** - close the encoder and any `VideoFrame`s, revoke stale blob URLs on the next render.

---

## Porting notes - borrowing from the CLI

Strong CLI parity is not required - the web app is its own tool. These notes exist so we port the CLI's *good decisions* on purpose, not so we chase its pixels:

- **Camera math**: Open3D's `setup_camera(fov, center, eye, up)` uses vertical FoV; so does Three.js `PerspectiveCamera`. The orbit (`eye = R(angle) @ base_eye`, fixed `up` per axis) and the distance formula port directly - Three.js is right-handed like Open3D, and setting eye/up/lookAt explicitly means the CLI's axis conventions carry over unchanged.
- **Point clouds**: CLI uses `defaultUnlit` with `point_size = clamp(width / 320, 2, 5)` pixels. Match with `THREE.PointsMaterial({ vertexColors: true, size: <same formula>, sizeAttenuation: false })` and `renderer.toneMapping = NoToneMapping` so vertex colours pass through untouched.
- **Meshes**: CLI uses `defaultLit` + one directional sun light. Approximate with a `DirectionalLight` at `[0.5, 1.0, 1.0]` plus a low ambient/hemisphere fill; exact match is a non-goal but direction and rough intensity should agree.
- **Colour space**: set `outputColorSpace = SRGBColorSpace`; the canvas is sRGB, which matches the CLI's `sRGB_color = True` intent.

---

## Settings design - clearer than the CLI flags

Since parity is not required, the form should not be a 1:1 transcription of the argparse flags. The CLI exposes implementation values (`--fov`, `--margin`); a UI can expose *intent*, with the live preview doing the explaining - every camera control below updates the preview immediately.

**Presets first.** A row of one-click presets covers the real use cases, with everything below as overrides:

- **Slides** - 1080x1080 MP4, 30 fps, 12 s (the PowerPoint case the CLI was built for)
- **Social preview** - 512x512 MP4, 30 fps, 8 s (small, shareable MP4)
- **Hi-res** - 2048x2048 MP4, 60 fps

**Grouped controls** (one page, three groups plus an advanced fold):

- *Camera*
  - **Up axis** (X/Y/Z) - reframing of the CLI's `--axis`: "which way is up for this scan" is the question users can actually answer; the turntable then spins around it. Default Z (matches the wheat scans).
  - **Spin direction** (CW/CCW) and **turns per loop** (default 1) - new, cheap, occasionally wanted.
  - **Framing** - slider from "tight" to "wide", replacing `--margin` (it is the same number, relabelled 1.1-3.0 with 1.5 default).
  - **Perspective** - slider from "telephoto (flat)" to "wide angle (dramatic)", replacing `--fov` (15-90 degrees, default 60). At the flat end this approximates orthographic, which reads well for scientific figures.
  - **Point size** - auto (the CLI's `clamp(width/320, 2, 5)` formula) with a manual override slider; now that it is interactive, users can tune for their point density.
- *Animation*
  - **Duration** slider (2-30 s, default 12) and **frame rate** presets (24/30/60). Show the derived frame count as a passive label ("360 frames") so render time is predictable.
- *Output*
  - **Size** - square presets (512/1080/1440/2048) plus a custom field, silently rounded to even. Square stays the default; free aspect is an advanced option, not a first-class control.
  - **Background** - white/black swatches plus a free colour picker.
- *Advanced (collapsed)* - raw fov/margin numbers, MP4 bitrate/quality, free aspect ratio.

The aesthetic win is mostly the presets and the live-preview coupling; the clarity win is renaming axis/margin/fov to up-axis/framing/perspective.

---

## Tech stack

| Concern | Primary option | Notes |
|---------|---------------|-------|
| Renderer | Three.js + WebGL 2 | Widest support, built-in `PLYLoader`. WebGPU is dropped: this workload (points + simple lit meshes) gains nothing from it. |
| Preview | Three.js OrbitControls | Free orbit by default; toggle to the deterministic export camera. |
| Frame capture | OffscreenCanvas in a worker | Keeps the UI responsive during multi-frame renders. |
| MP4 encoding | WebCodecs `VideoEncoder` + mediabunny | Hardware-accelerated where available, no big download, no COOP/COEP. Feature-detect via `isConfigSupported()`. |
| PWA shell | Vite + `vite-plugin-pwa` | Static build, service worker generated automatically, GitHub Pages compatible. |
| Build / dev | Vite | Dev server, bundling, worker imports, and base-path handling for GitHub Pages. |
| Unit tests | Vitest | Camera math, input validation, timestamp/encoder helpers. |
| E2E tests | Playwright (Chromium only for speed) | Upload a PLY, render, verify MP4 is produced and playable. |
| CI / deploy | GitHub Actions | Build, run tests, deploy `dist/` to GitHub Pages on pushes to `main`. |

---

## Deployment - GitHub Pages

Because the app is entirely client-side, it can be hosted as a static site.

- **Build output**: `vite build` produces a `dist/` directory with all static assets.
- **Base path**: GitHub Pages project sites live at `https://<org>.github.io/<repo>/`. Vite must be configured with `base: '/3d-turntable-animator/'` so asset URLs resolve correctly.
- **HTTPS**: GitHub Pages serves over HTTPS, which is required for service workers, WebCodecs, and OffscreenCanvas in some contexts.
- **GitHub Action**:
  - Checkout.
  - Setup Node.js.
  - `npm ci`.
  - `npm run build`.
  - Upload `dist/` as a Pages artifact.
  - Deploy to GitHub Pages.
- **Branching**: deploy on every push to `main`. PRs can run the build and tests but should not deploy.

---

## Known constraints and risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| H.264 `VideoEncoder` unavailable | App cannot encode MP4 | Detect up front and show a clear unsupported-browser message. No fallback in v1. |
| Huge point clouds (tens of millions of points) | GPU memory / load stalls | ~24 bytes/point on GPU means 10 M points is ~240 MB. Warn above a few million points; offer optional decimation for preview while rendering full-res for export. |
| High output resolutions | Hardware encoders commonly cap around 4096x4096 | Cap the form at 4K, round to even dimensions, and surface `isConfigSupported()` failures clearly. |
| Rendering fidelity differs from Open3D/Filament | Output looks like a Three.js render | Work the "Fidelity notes" checklist; document remaining differences; keep the CLI as the high-fidelity path. |
| GitHub Pages base-path breakage | Relative assets 404 | Vite `base` option and Playwright E2E against the built site catch this. |

---

## Suggested first milestones

1. **Proof of concept (de-risks WebCodecs)**
   - Feed a procedurally generated spinning-cube frame sequence through `VideoEncoder` + mediabunny to a playable MP4 in Chrome, Firefox, and Safari.
   - Load a real PLY in Three.js and display it with vertex colours.
2. **Pipeline integration**
   - PLY upload → preview → render worker with OffscreenCanvas → streaming MP4 encode with progress bar.
   - Parameter form wired to the deterministic camera math; verify output against a CLI render of the same file.
3. **PWA + deploy**
   - Add `vite-plugin-pwa`, offline shell, input validation, error surfaces.
   - Add GitHub Actions workflow to build and deploy to GitHub Pages.
   - Playwright smoke test against the deployed site.
4. **Future revisit (not v1)**
   - GIF output via `gifenc` or external converter guidance.
   - ffmpeg.wasm fallback for older browsers, if user demand justifies the size/complexity.

---

## Open questions

Resolved in v3:

- ~~Output formats?~~ MP4 only for the first build. GIF and other formats are deferred.
- ~~Browser fallback?~~ None in v1. Unsupported browsers get a clear message instead of a heavy fallback.
- ~~Hosting?~~ GitHub Pages, deployed via GitHub Actions.

Still open:

- Do we want a hybrid escape hatch later - upload to a backend for high-fidelity Open3D renders?
- Point-count threshold for the "this file is very large" warning (needs a quick benchmark with a real wheat scan).

---

## Recommendation

Build the MP4-only, WebCodecs-only PWA and ship it on GitHub Pages. Removing GIF and ffmpeg.wasm shrinks the first milestone to the essential loop - PLY → preview → streaming MP4 encode → download - and lets the team prove the core WebCodecs pipeline before reintroducing secondary formats or fallback encoders. The remaining engineering work is fidelity (camera, point sizing, colour handling) and graceful handling of large point clouds.
