// Output integrity verification.
//
// `VideoEncoder.isConfigSupported()` can return `true` for a codec that then
// produces a broken bitstream — most notably Firefox's H.264 encoder, which mangles
// the stream dimensions (e.g. a 512x512 render muxes as 16x160) when fed frames from
// a WebGL canvas. To stay correct without brittle user-agent sniffing, the worker
// runs a tiny probe encode of the *actual* rendered frames through each supported
// candidate and re-reads the muxed dimensions; the first candidate whose output
// matches the requested size is used for the full render.

import { Input, BlobSource, ALL_FORMATS } from 'mediabunny';

export interface MuxedDimensions {
  width: number;
  height: number;
  packetCount: number;
}

/** Re-read a muxed blob and report the primary video track's real dimensions. */
export async function readMuxedDimensions(blob: Blob): Promise<MuxedDimensions> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return { width: 0, height: 0, packetCount: 0 };
    const stats = await track.computePacketStats();
    return {
      width: track.displayWidth,
      height: track.displayHeight,
      packetCount: stats.packetCount,
    };
  } finally {
    input.dispose?.();
  }
}

/** True if a muxed probe blob has packets at exactly the requested dimensions. */
export function dimensionsMatch(dims: MuxedDimensions, width: number, height: number): boolean {
  return dims.packetCount > 0 && dims.width === width && dims.height === height;
}
