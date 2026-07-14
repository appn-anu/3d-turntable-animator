// Render worker (Milestone 2): rebuilds the scene from the transferred geometry
// copy, then streams turntable frames through WebCodecs + mediabunny on an
// OffscreenCanvas. Reuses the shared scene builder and the Milestone 0 encode
// core, so nothing about the pixels or the muxing is worker-specific.
//
// Lifecycle: the main thread spawns a fresh worker per export and terminates it on
// completion / cancellation, so a hard `terminate()` is the cancellation reset —
// the internal AbortController is a graceful backstop for encoder-side aborts.

import { rebuildGeometry } from './exportGeometry';
import { TurntableRenderer } from './renderModel';
import { encodeCanvasSequence, type EncodeResult } from '../encode/encode';
import {
  preferWebmFirst,
  probeCandidates,
  type CodecCandidate,
  type EncodeRequest,
  type PickedConfig,
} from '../encode/encoderConfig';
import { dimensionsMatch, readMuxedDimensions } from '../encode/verify';
import { frameCount } from '../encode/timestamps';
import type {
  MainToWorker,
  RenderExportOptions,
  WorkerToMain,
} from '../export/protocol';
import type { ExportGeometryPayload } from './exportGeometry';

// `self` typed minimally to avoid pulling the whole WebWorker lib (which clashes
// with the DOM lib this project compiles against).
interface WorkerScope {
  postMessage(message: WorkerToMain, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<MainToWorker>) => void): void;
}
const ctx = self as unknown as WorkerScope;

let abort: AbortController | null = null;

ctx.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    abort?.abort();
    return;
  }
  if (msg.type === 'start') {
    void run(msg.geometry, msg.options);
  }
});

function post(message: WorkerToMain): void {
  ctx.postMessage(message);
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function humanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw || 'The video could not be encoded.';
}

/** Firefox's H.264 WebCodecs encoder is the unreliable one; prefer VP9->WebM there. */
function prefersWebm(): boolean {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /firefox/i.test(ua);
}

/**
 * Supported candidates in the order to try them: engine-aware (VP9/WebM first on
 * Firefox), then the isConfigSupported-passing candidates in preference order.
 */
async function orderedCandidates(
  req: EncodeRequest,
  filter?: (candidate: CodecCandidate) => boolean,
): Promise<PickedConfig[]> {
  const probes = await probeCandidates(req);
  const supported = probes.filter((p) => p.supported && (!filter || filter(p.candidate)));
  const ordered = prefersWebm() ? preferWebmFirst(supported) : supported;
  return ordered.map((p) => {
    const picked: PickedConfig = { candidate: p.candidate, config: p.config };
    if (p.resolvedConfig) picked.resolvedConfig = p.resolvedConfig;
    return picked;
  });
}

async function run(geometry: ExportGeometryPayload, options: RenderExportOptions): Promise<void> {
  abort = new AbortController();
  let renderer: TurntableRenderer | null = null;

  try {
    post({ type: 'progress', phase: 'preparing' });

    const loaded = rebuildGeometry(geometry);
    const frames = frameCount(options.durationSeconds, options.fps);

    renderer = new TurntableRenderer(loaded, {
      width: options.width,
      height: options.height,
      axis: options.axis,
      verticalFovDeg: options.verticalFovDeg,
      margin: options.margin,
      turns: options.turns,
      direction: options.direction,
      background: options.background,
    });
    const boundRenderer = renderer;

    // Exact-config preflight before the full render (gpt #3).
    const req: EncodeRequest = {
      width: options.width,
      height: options.height,
      fps: options.fps,
      ...(options.bitrate !== undefined ? { bitrate: options.bitrate } : {}),
    };
    const filter = options.forceMediabunnyCodec
      ? (c: CodecCandidate) => c.mediabunnyCodec === options.forceMediabunnyCodec
      : undefined;
    const candidates = await orderedCandidates(req, filter);
    if (candidates.length === 0) {
      post({
        type: 'error',
        message:
          'This browser cannot encode MP4 or WebM at these settings. Try a smaller size or frame rate.',
        canRetryLowerRes: true,
      });
      return;
    }

    // Encode with the preferred candidate, then verify the *real* muxed size. A
    // codec that lies about support (Firefox H.264 -> 16x160) fails the check and we
    // fall through to the next candidate, guaranteeing a correct file (gpt #4).
    let delivered: EncodeResult | null = null;
    const signal = abort.signal;
    for (const picked of candidates) {
      if (signal.aborted) throw new DOMException('Encode canceled', 'AbortError');
      post({ type: 'progress', phase: 'rendering', frame: 0, totalFrames: frames });
      const result = await encodeCanvasSequence({
        canvas: boundRenderer.canvas,
        frames,
        fps: options.fps,
        picked,
        drawFrame: (_canvas, index, total) => boundRenderer.renderFrame(index, total),
        signal,
        onProgress: (encoded, total) =>
          post({ type: 'progress', phase: 'rendering', frame: encoded, totalFrames: total }),
      });
      const dims = await readMuxedDimensions(result.blob);
      if (dimensionsMatch(dims, options.width, options.height)) {
        delivered = result;
        break;
      }
    }

    if (!delivered) {
      post({
        type: 'error',
        message: 'The encoded video was invalid on this browser. Try a smaller size or frame rate.',
        canRetryLowerRes: true,
      });
      return;
    }

    post({ type: 'progress', phase: 'finalising' });
    post({
      type: 'done',
      blob: delivered.blob,
      container: delivered.container,
      codec: delivered.codec,
      frames: delivered.frames,
    });
  } catch (err) {
    if (isAbort(err)) {
      post({ type: 'canceled' });
      return;
    }
    // A runtime encoder failure at this size is the common case worth retrying
    // at a lower resolution (gpt #4).
    post({ type: 'error', message: humanError(err), canRetryLowerRes: true });
  } finally {
    renderer?.dispose();
    abort = null;
  }
}
