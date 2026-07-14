// Main-thread orchestration of a render+encode export (Milestone 2). Owns the
// worker lifecycle, transfers an independent geometry COPY (never the preview's
// buffers, gpt #2), relays worker messages into monotonic progress, and turns the
// finished blob into a downloadable object URL. Cancellation is a hard worker
// terminate — the cleanest possible reset (gpt #17).

import { extractExportGeometry } from '../scene/exportGeometry';
import type { LoadedPly } from '../ply/load';
import type { RenderExportOptions, WorkerToMain } from './protocol';
import {
  describeProgress,
  overallProgress,
  renderFraction,
  type ExportPhase,
} from './progress';

export interface ProgressState {
  phase: ExportPhase;
  /** Non-decreasing 0-100 for the progress bar. */
  percent: number;
  label: string;
}

export interface DoneState {
  url: string;
  blob: Blob;
  filename: string;
  container: 'mp4' | 'webm';
}

export interface ErrorState {
  message: string;
  canRetryLowerRes: boolean;
}

export interface ExportCallbacks {
  onProgress(state: ProgressState): void;
  onDone(state: DoneState): void;
  onError(state: ErrorState): void;
  onCanceled(): void;
}

function extension(container: 'mp4' | 'webm'): string {
  return container === 'mp4' ? 'mp4' : 'webm';
}

/** Stable, descriptive filename for the downloaded video. */
export function exportFilename(options: RenderExportOptions, container: 'mp4' | 'webm'): string {
  return `turntable_${options.width}x${options.height}_${options.fps}fps_${options.axis}.${extension(container)}`;
}

export class ExportController {
  private worker: Worker | null = null;
  private lastPercent = 0;
  private lastUrl: string | null = null;

  /** True while a render is in flight. */
  get running(): boolean {
    return this.worker !== null;
  }

  /**
   * Kick off an export. Any in-flight render is cancelled first. The geometry copy
   * is extracted and its buffers transferred, so the preview keeps its own.
   */
  start(loaded: LoadedPly, options: RenderExportOptions, callbacks: ExportCallbacks): void {
    this.hardStopWorker();
    this.lastPercent = 0;

    let message;
    try {
      message = extractExportGeometry(loaded);
    } catch (err) {
      callbacks.onError({
        message: err instanceof Error ? err.message : 'Could not prepare geometry for export.',
        canRetryLowerRes: false,
      });
      return;
    }

    const worker = new Worker(new URL('../scene/renderWorker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker = worker;

    worker.onmessage = (ev: MessageEvent<WorkerToMain>) => {
      this.handleMessage(ev.data, options, callbacks);
    };
    worker.onerror = (ev) => {
      callbacks.onError({
        message: ev.message || 'The render worker crashed unexpectedly.',
        canRetryLowerRes: false,
      });
      this.hardStopWorker();
    };

    worker.postMessage({ type: 'start', geometry: message.payload, options }, message.transfer);
  }

  private handleMessage(
    msg: WorkerToMain,
    options: RenderExportOptions,
    callbacks: ExportCallbacks,
  ): void {
    switch (msg.type) {
      case 'progress': {
        const local =
          msg.phase === 'rendering' ? renderFraction(msg.frame ?? 0, msg.totalFrames ?? 0) : 0;
        const raw = Math.round(overallProgress(msg.phase, local) * 100);
        // Monotonic: a phase change or reorder must never rewind the bar.
        this.lastPercent = Math.max(this.lastPercent, raw);
        callbacks.onProgress({
          phase: msg.phase,
          percent: this.lastPercent,
          label: describeProgress(msg.phase, msg.frame, msg.totalFrames),
        });
        break;
      }
      case 'done': {
        this.revokeUrl();
        const url = URL.createObjectURL(msg.blob);
        this.lastUrl = url;
        this.lastPercent = 100;
        callbacks.onProgress({ phase: 'ready', percent: 100, label: describeProgress('ready') });
        callbacks.onDone({
          url,
          blob: msg.blob,
          filename: exportFilename(options, msg.container),
          container: msg.container,
        });
        this.hardStopWorker();
        break;
      }
      case 'error': {
        callbacks.onError({ message: msg.message, canRetryLowerRes: msg.canRetryLowerRes });
        this.hardStopWorker();
        break;
      }
      case 'canceled': {
        callbacks.onCanceled();
        this.hardStopWorker();
        break;
      }
    }
  }

  /** User-initiated cancel: stop the worker dead and report it (gpt #17). */
  cancel(callbacks?: Pick<ExportCallbacks, 'onCanceled'>): void {
    if (!this.worker) return;
    this.hardStopWorker();
    callbacks?.onCanceled();
  }

  /** Release the last download URL (call before the app is torn down). */
  revokeUrl(): void {
    if (this.lastUrl) {
      URL.revokeObjectURL(this.lastUrl);
      this.lastUrl = null;
    }
  }

  dispose(): void {
    this.hardStopWorker();
    this.revokeUrl();
  }

  private hardStopWorker(): void {
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
  }
}
