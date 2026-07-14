// The message contract between the main-thread ExportController and the render
// worker. Kept in one small module with no runtime imports beyond types so both
// sides agree on the shape and neither pulls the other's heavy dependencies.

import type { ExportGeometryPayload } from '../scene/exportGeometry';
import type { Axis, SpinDirection } from '../camera/turntable';
import type { ExportPhase } from './progress';

/** Everything the worker needs to render + encode one turntable video. */
export interface RenderExportOptions {
  /** Square output for v1; width === height. */
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  axis: Axis;
  verticalFovDeg: number;
  margin: number;
  turns: number;
  direction: SpinDirection;
  /** Background colour (any CSS/THREE.Color-compatible string). */
  background: string;
  /** Explicit bitrate (bits/sec); derived from resolution when omitted. */
  bitrate?: number;
  /** Force a codec/container, e.g. 'vp9' to exercise the WebM path. */
  forceMediabunnyCodec?: 'avc' | 'vp9';
}

// --- Main thread -> worker ----------------------------------------------------

export interface StartRenderMessage {
  type: 'start';
  geometry: ExportGeometryPayload;
  options: RenderExportOptions;
}

export interface CancelRenderMessage {
  type: 'cancel';
}

export type MainToWorker = StartRenderMessage | CancelRenderMessage;

// --- Worker -> main thread ----------------------------------------------------

export interface ProgressMessage {
  type: 'progress';
  phase: ExportPhase;
  /** Frames encoded so far (rendering phase only). */
  frame?: number;
  totalFrames?: number;
}

export interface DoneMessage {
  type: 'done';
  blob: Blob;
  container: 'mp4' | 'webm';
  codec: string;
  frames: number;
}

export interface RenderErrorMessage {
  type: 'error';
  message: string;
  /** True when retrying at a lower resolution is a reasonable next step. */
  canRetryLowerRes: boolean;
}

export interface CanceledMessage {
  type: 'canceled';
}

export type WorkerToMain =
  | ProgressMessage
  | DoneMessage
  | RenderErrorMessage
  | CanceledMessage;
