/**
 * The streaming encode core: render a frame, wrap it in a VideoFrame, hand it to
 * WebCodecs `VideoEncoder`, and pipe the resulting packets into a mediabunny MP4
 * or WebM. Each frame is dropped before the next is drawn, so peak memory stays a
 * handful of frames rather than the whole sequence.
 *
 * Shared by the Milestone 0 compat harness and (later) the render worker.
 */

import {
  Output,
  Mp4OutputFormat,
  WebMOutputFormat,
  BufferTarget,
  EncodedVideoPacketSource,
  EncodedPacket,
} from 'mediabunny';
import type { PickedConfig } from './encoderConfig.js';
import { frameTimestampMicros, frameDurationMicros, isKeyFrame } from './timestamps.js';

/** Draws frame `index` of `total` onto `canvas`. Called once per frame. */
export type DrawFrame = (
  canvas: OffscreenCanvas | HTMLCanvasElement,
  index: number,
  total: number,
) => void;

export interface EncodeOptions {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  frames: number;
  fps: number;
  picked: PickedConfig;
  drawFrame: DrawFrame;
  onProgress?: (encoded: number, total: number) => void;
  /** Aborting stops scheduling, closes the encoder, and rejects (gpt #17). */
  signal?: AbortSignal;
  /** Max in-flight frames in the encoder queue before we wait (backpressure). */
  maxQueue?: number;
}

export interface EncodeResult {
  blob: Blob;
  container: 'mp4' | 'webm';
  codec: string;
  /**
   * Packet timestamps (microseconds) in *emission* (decode) order. Some encoders
   * (e.g. Firefox H.264) reorder around B-frames, so this is not necessarily
   * ascending - callers must treat it as an unordered set keyed by value.
   */
  timestampsMicros: number[];
  /** Timestamps (microseconds) of the packets the encoder emitted as keyframes. */
  keyFrameTimestampsMicros: number[];
  frames: number;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Runs the full render->encode->mux loop and returns a playable blob plus the
 * timestamp/keyframe telemetry the harness verifies against.
 */
export async function encodeCanvasSequence(opts: EncodeOptions): Promise<EncodeResult> {
  const { canvas, frames, fps, picked, drawFrame, onProgress, signal } = opts;
  const maxQueue = opts.maxQueue ?? 4;
  const container = picked.candidate.container;

  const output = new Output({
    format: container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const source = new EncodedVideoPacketSource(picked.candidate.mediabunnyCodec);
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  const timestampsMicros: number[] = [];
  const keyFrameTimestampsMicros: number[] = [];

  // Packets must be muxed serially in emission (decode) order. Chain the async
  // adds and surface the first error.
  let addChain: Promise<void> = Promise.resolve();
  let addError: unknown = null;

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      timestampsMicros.push(chunk.timestamp);
      if (chunk.type === 'key') keyFrameTimestampsMicros.push(chunk.timestamp);
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      addChain = addChain.then(() => source.add(packet, meta)).catch((err) => {
        addError ??= err;
      });
    },
    error: (err) => {
      addError ??= err;
    },
  });
  encoder.configure(picked.config);

  const abort = () => {
    addError ??= new DOMException('Encode canceled', 'AbortError');
  };
  signal?.addEventListener('abort', abort, { once: true });

  try {
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw new DOMException('Encode canceled', 'AbortError');
      if (addError) throw addError;

      // Backpressure: let the encoder drain before queueing more work.
      while (encoder.encodeQueueSize > maxQueue) {
        await nextTask();
        if (addError) throw addError;
        if (signal?.aborted) throw new DOMException('Encode canceled', 'AbortError');
      }

      drawFrame(canvas, i, frames);
      const frame = new VideoFrame(canvas as CanvasImageSource, {
        timestamp: frameTimestampMicros(i, fps),
        duration: frameDurationMicros(fps),
      });
      encoder.encode(frame, { keyFrame: isKeyFrame(i, fps) });
      frame.close();

      onProgress?.(i + 1, frames);
    }

    await encoder.flush();
    await addChain;
    if (addError) throw addError;

    await output.finalize();

    const buffer = output.target.buffer;
    if (!buffer) throw new Error('Muxer produced no output buffer');
    const blob = new Blob([buffer], {
      type: container === 'mp4' ? 'video/mp4' : 'video/webm',
    });

    return {
      blob,
      container,
      codec: picked.candidate.codec,
      timestampsMicros,
      keyFrameTimestampsMicros,
      frames,
    };
  } finally {
    signal?.removeEventListener('abort', abort);
    if (encoder.state !== 'closed') encoder.close();
    // If we bailed before finalize, cancel the muxer so its buffers are released.
    if (output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => {});
    }
  }
}
