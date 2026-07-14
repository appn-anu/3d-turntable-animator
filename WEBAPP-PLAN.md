# Turntable Web App - Client-Side Architecture Plan

> Status: evaluation draft, v2 (reviewed 2026-07-13)  
> Scope: one-page, offline-capable, client-side-only PWA for turning `render_turntable.py` into a browser-based tool.  
> v2 direction change: **WebCodecs is the primary encoder; ffmpeg.wasm is demoted to a fallback.** See review notes below.

---

## Review notes (v2)

The v1 draft was architected around ffmpeg.wasm, which forced three heavy design decisions: a 25-30 MB WASM download, PNG frames staged in OPFS, and possible COOP/COEP headers for multi-threading. All three largely evaporate if we encode with **WebCodecs** instead:

- `VideoEncoder` is supported in Chrome/Edge, Safari 16.4+, and Firefox 130+ - it is no longer a Chromium-only bet.
- Encoding is hardware-accelerated where available: H.264 at 1280x1280 @ 30 fps encodes at or above realtime, versus minutes in single-threaded ffmpeg.wasm.
- Frames go straight from the canvas into the encoder as `VideoFrame`s - no PNG encode/decode roundtrip, and no staging frames on disk, so OPFS is off the happy path entirely. Peak memory is one frame plus the encoder queue, not `n_frames` PNGs.
- MP4 muxing is a small pure-JS library (mediabunny, or its predecessor mp4-muxer) - tens of KB, not tens of MB.
- GIF encoding also doesn't need ffmpeg: `gifenc` is a tiny, fast pure-JS encoder.

ffmpeg.wasm stays in the plan only as a lazy-loaded fallback for browsers that lack an H.264 `VideoEncoder`.

Parity findings from re-reading `render_turntable.py` (decisions to make before building - see "Fidelity notes"):

- **The CLI's GIF is 3x slower than its MP4.** The GIF path feeds *all* frames to ffmpeg at 10 fps, so the default 12 s / 30 fps render (360 frames) becomes a 36 s GIF loop. Decision (v2 review): this is a bug - **the GIF should match the MP4 duration**, so the web app samples every `round(fps / 10)`-th frame. The CLI fix is tracked in `SCRIPT-FIXES.md`.
- The MP4 `scale=` filter in the script is a no-op (frames are already rendered at the target size). The web app can simply render at the requested resolution and skip scaling.
- `yuv420p` requires even dimensions; the parameter form should round width/height to even numbers.

---

## Goals

- Convert the current CLI workflow (`render_turntable.py`) into a single-page web app.
- Work offline after first load (PWA).
- Render the preview and final frames entirely in the browser.
- Encode MP4/GIF in the browser via WebCodecs (ffmpeg.wasm as fallback).
- Keep all options exposed on one page.
- Show a progress bar during the combined render+encode pass.

---

## Non-goals

- Pixel-perfect reproduction of Open3D/Filament output.
- Supporting every browser equally on day one.
- Server-side rendering, queues, or persistence.
- Multi-user concurrency or account management.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ Main thread - PWA shell                                        │
│ - Service worker caches static assets (JS, WASM, fonts)        │
│ - One-page UI: upload, parameter form, progress, downloads     │
│ - Three.js interactive preview (free orbit/zoom)               │
└───────────────────────────┬────────────────────────────────────┘
                            │ transfer geometry buffers + params
                            ▼
┌────────────────────────────────────────────────────────────────┐
│ Render worker (OffscreenCanvas) - streaming pipeline           │
│                                                                │
│   for each frame i:                                            │
│     render deterministic orbit camera frame (Three.js)         │
│     ├─► VideoFrame ─► WebCodecs VideoEncoder ─► MP4 muxer      │
│     └─► every k-th frame ─► gifenc                             │
│     post progress (i / n_frames)                               │
│                                                                │
│   finalize ─► MP4 + GIF blobs ─► main thread ─► download links │
└────────────────────────────────────────────────────────────────┘

Fallback path (no H.264 VideoEncoder): render worker writes PNG
frames to OPFS; a lazy-loaded ffmpeg.wasm worker encodes them
(this is the v1 design, kept in reserve).
```

Render and encode are a single streaming loop in one worker: each frame is handed to the encoder and dropped before the next one is rendered. That is what removes the memory problem - at 1280x1280, raw RGBA is ~6.5 MB/frame, so 360 buffered frames would be ~2.4 GB; streamed, peak memory is a handful of frames.

---

## Component responsibilities

### 1. Main thread / PWA shell

- Registers a service worker that caches the app bundle, Three.js, muxer, and gifenc. The ffmpeg.wasm fallback core is cached only after first use.
- Hosts the one-page UI:
  - PLY file upload (drag/drop or picker), parsed with `THREE.PLYLoader` (handles ASCII and binary; no faces means point cloud, rendered as `THREE.Points`).
  - Controls for width, height, background, axis, duration, fps, fov, margin, GIF toggle.
  - A Three.js canvas for interactive preview (free orbit), plus a "preview export camera" toggle that locks the camera to the deterministic turntable path.
  - Progress bar and download buttons.
- Spawns the render worker, transferring the parsed geometry buffers (zero-copy).
- Receives progress messages; creates blob URLs from the returned MP4/GIF.

### 2. Render worker - streaming render + encode

- Rebuilds the scene from transferred buffers; renders to an `OffscreenCanvas` so long renders never jank the UI.
- Centers geometry and computes camera distance with the same math as the CLI (see "Fidelity notes").
- Per frame: position the camera on the orbit, render, wrap the canvas in a `VideoFrame`, and feed it to `VideoEncoder`. Throttle on `encodeQueueSize` for backpressure.
- MP4: `VideoEncoder` with an `avc1.*` codec string at the user's fps, muxed by mediabunny/mp4-muxer.
- GIF: sample every `round(fps / 10)`-th frame (so the GIF loop matches the MP4 duration), read back pixels, quantize and encode with gifenc.
- Posts progress after every frame (or every N frames); returns final blobs via transfer.

### 3. Fallback encoder worker (ffmpeg.wasm) - only when needed

- Used only if `VideoEncoder.isConfigSupported()` rejects H.264 on this browser.
- Render worker switches to writing PNG frames into a job-scoped OPFS directory; this worker mounts them into ffmpeg's virtual FS and runs the equivalent of the CLI commands, then cleans up.

---

## Frame flow

1. **Upload** - user drops a PLY; main thread parses it, centers it via axis-aligned bbox (same as CLI), and populates the preview.
2. **Preview** - Three.js renders with vertex colours; camera is free by default, with a toggle to preview the exact export orbit. Parameter changes update the preview live where feasible.
3. **Render start** - main thread validates inputs (rounding dimensions to even), computes `n_frames = round(duration * fps)` and `distance = (max_size / (2 * tan(fov / 2))) * margin`, checks `VideoEncoder` support to pick the pipeline, and transfers geometry + params to the render worker.
4. **Streaming render+encode** - the worker loops over frames as described above, posting progress. One pass produces both MP4 and GIF.
5. **Download** - worker returns blobs; main thread creates blob URLs and enables download links. Optional: auto-trigger download.
6. **Cleanup** - close the encoder and any `VideoFrame`s, revoke stale blob URLs on the next render. (OPFS cleanup only applies to the fallback path.)

---

## Porting notes - borrowing from the CLI

Strong CLI parity is not required (v2 decision) - the web app is its own tool. These notes exist so we port the CLI's *good decisions* (camera math, sensible point sizing) on purpose, not so we chase its pixels:

- **Camera math**: Open3D's `setup_camera(fov, center, eye, up)` uses vertical FoV; so does Three.js `PerspectiveCamera`. The orbit (`eye = R(angle) @ base_eye`, fixed `up` per axis) and the distance formula port directly - Three.js is right-handed like Open3D, and setting eye/up/lookAt explicitly means the CLI's axis conventions carry over unchanged.
- **Point clouds**: CLI uses `defaultUnlit` with `point_size = clamp(width / 320, 2, 5)` pixels. Match with `THREE.PointsMaterial({ vertexColors: true, size: <same formula>, sizeAttenuation: false })` and `renderer.toneMapping = NoToneMapping` so vertex colours pass through untouched.
- **Meshes**: CLI uses `defaultLit` + one directional sun light. Approximate with a `DirectionalLight` at `[0.5, 1.0, 1.0]` plus a low ambient/hemisphere fill; exact match is a non-goal but direction and rough intensity should agree.
- **Colour space**: set `outputColorSpace = SRGBColorSpace`; the canvas is sRGB, which matches the CLI's `sRGB_color = True` intent.
- **GIF timing**: matched duration (sample every `round(fps / 10)`-th frame). The CLI's 3x-slower GIF is a bug, tracked in `SCRIPT-FIXES.md`.
- **GIF palette**: ffmpeg uses a global 128-colour palette with Bayer dither; gifenc quantizes per-frame at up to 256 colours. Output will differ slightly - fine, parity is not a goal.

---

## Settings design - clearer than the CLI flags

Since parity is not required, the form should not be a 1:1 transcription of the argparse flags. The CLI exposes implementation values (`--fov`, `--margin`); a UI can expose *intent*, with the live preview doing the explaining - every camera control below updates the preview immediately, which is what makes "framing" and "perspective" self-evident where "margin 1.5" never was.

**Presets first.** A row of one-click presets covers the real use cases, with everything below as overrides:

- **Slides** - 1080x1080 MP4, 30 fps, 12 s (the PowerPoint case the CLI was built for)
- **Chat / GIF** - 512x512 GIF only, 8 s (small enough to paste anywhere)
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
  - **Formats** - MP4 and GIF as independent checkboxes (replaces the inverted `--no-gif` flag).
  - **Background** - white/black swatches plus a free colour picker, and a **transparent** option for GIF output (and PNG-sequence export if we ever add it; MP4/H.264 stays opaque). Transparent backgrounds are genuinely useful for dropping renders onto slides.
- *Advanced (collapsed)* - raw fov/margin numbers, MP4 bitrate/quality, free aspect ratio.

The aesthetic win is mostly the presets and the live-preview coupling; the clarity win is renaming axis/margin/fov to up-axis/framing/perspective.

---

## Tech stack

| Concern | Primary option | Fallback / alternative | Notes |
|---------|---------------|------------------------|-------|
| Renderer | Three.js + WebGL 2 | - | Widest support, built-in `PLYLoader`. WebGPU is dropped from v1: this workload (points + simple lit meshes) gains nothing from it. |
| Preview | Three.js OrbitControls | - | Free orbit by default; toggle to the deterministic export camera. |
| Frame capture | OffscreenCanvas in a worker | Main-thread canvas | OffscreenCanvas keeps the UI responsive during 360-frame renders. |
| MP4 encoding | WebCodecs `VideoEncoder` + mediabunny (or mp4-muxer) | ffmpeg.wasm single-thread | Hardware-accelerated, no big download, no COOP/COEP. Feature-detect via `isConfigSupported()`. |
| GIF encoding | gifenc | ffmpeg.wasm | Tiny pure-JS encoder; runs in the same worker loop. |
| Frame scratch space | none (streaming) | OPFS (fallback path only) | Streaming makes disk staging unnecessary on the happy path. |
| PWA shell | vanilla JS + service worker | Vite PWA plugin | Keep it minimal; with ffmpeg.wasm demoted, total first-load is a few hundred KB, not ~30 MB. |

---

## Known constraints and risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| H.264 `VideoEncoder` unavailable (older browsers, some Linux/codec configs) | No fast path | Feature-detect up front; fall back to lazy-loaded ffmpeg.wasm with a "this will be slower" notice. |
| Huge point clouds (tens of millions of points) | GPU memory / load stalls | ~24 bytes/point on GPU means 10 M points is ~240 MB. Warn above a few million points; offer optional decimation for preview while rendering full-res for export. |
| High output resolutions | Hardware encoders commonly cap around 4096x4096 | Cap the form at 4K, round to even dimensions, and surface `isConfigSupported()` failures clearly. |
| Rendering fidelity differs from Open3D/Filament | Output looks like a Three.js render | Work the "Fidelity notes" checklist; document remaining differences; keep the CLI as the high-fidelity path. |
| ffmpeg.wasm fallback is slow and heavy | Poor experience on old browsers | Acceptable - it is the degraded path, clearly labelled, and its ~25-30 MB core is only fetched when needed. |
| GIF encode is CPU-bound JS | Adds time on long renders | It shares the worker loop at 10 fps effective rate; if it ever dominates, move gifenc to its own worker. |

---

## Suggested first milestones

1. **Proof of concept (de-risks the new bet first)**
   - Feed a procedurally generated spinning-cube frame sequence through `VideoEncoder` + muxer to a playable MP4 in Chrome, Firefox, and Safari.
   - Load a real PLY in Three.js and display it with vertex colours.
2. **Pipeline integration**
   - PLY upload → preview → render worker with OffscreenCanvas → streaming MP4 encode with progress bar.
   - Parameter form wired to the deterministic camera math; verify output against a CLI render of the same file.
3. **GIF + fallback**
   - Add gifenc output (matched to MP4 duration).
   - Add the ffmpeg.wasm/OPFS fallback path behind feature detection.
4. **Polish / PWA**
   - Service worker caching, offline shell, input validation, error surfaces.

---

## Open questions

Resolved in v2 (recommendations, revisit if wrong):

- ~~Chromium-only vs WebGL 2 fallback?~~ WebGL 2 + WebCodecs covers Chrome, Edge, Safari 16.4+, Firefox 130+; there is no Chromium-only pressure anymore. WebGPU dropped from v1.
- ~~Max acceptable WASM first-load size?~~ Moot on the happy path; the ffmpeg.wasm fallback lazy-loads only for old browsers.
- ~~Cap output resolution?~~ Cap at 4096x4096 (hardware encoder limit), enforce even dimensions, default to 1280x1280.
- ~~Preview: exact orbit math or free inspection?~~ Both: free orbit by default, toggle to preview the exact export path.
- ~~GIF timing?~~ Match the MP4 duration; the CLI's slow spin was unintentional (fix tracked in `SCRIPT-FIXES.md`).

Still open:

- Do we want a hybrid escape hatch later - upload to a backend for high-fidelity Open3D renders?
- Point-count threshold for the "this file is very large" warning (needs a quick benchmark with a real wheat scan).

---

## Recommendation

A pure client-side PWA is not just feasible but considerably easier than the v1 draft assumed: with WebCodecs as the encoder, the two biggest v1 risks (ffmpeg.wasm size/speed and frame-sequence memory) disappear from the primary path. The remaining engineering work is fidelity (matching the CLI's camera, point sizing, and colour handling - tractable, see checklist) and graceful handling of very large point clouds. Start milestone 1 with the WebCodecs proof of concept, since it is the one new bet everything else leans on.
