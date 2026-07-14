import { describe, it, expect } from 'vitest';
import {
  selectAvcLevel,
  selectVp9Level,
  avcCodecString,
  vp9CodecString,
  defaultBitrate,
  buildEncoderConfig,
  preferWebmFirst,
} from './encoderConfig.js';

describe('selectAvcLevel', () => {
  it('picks the smallest level that fits the frame size and rate', () => {
    expect(selectAvcLevel(512, 512, 30)?.name).toBe('3.0');
    expect(selectAvcLevel(1080, 1080, 30)?.name).toBe('3.2');
    expect(selectAvcLevel(2048, 2048, 30)?.name).toBe('5.0');
    // 60 fps at 2048^2 exceeds level 5.0's macroblock rate, bumping to 5.1.
    expect(selectAvcLevel(2048, 2048, 60)?.name).toBe('5.1');
  });

  it('returns null when no level can hold the frame', () => {
    expect(selectAvcLevel(20000, 20000, 30)).toBeNull();
  });
});

describe('selectVp9Level', () => {
  it('picks the smallest level that fits picture size and sample rate', () => {
    expect(selectVp9Level(512, 512, 30)?.code).toBe('30');
    expect(selectVp9Level(1080, 1080, 30)?.code).toBe('40');
    expect(selectVp9Level(2048, 2048, 30)?.code).toBe('50');
    expect(selectVp9Level(2048, 2048, 60)?.code).toBe('50');
  });
});

describe('codec strings', () => {
  it('formats AVC as avc1.PPCCLL', () => {
    expect(avcCodecString('high', 0x28)).toBe('avc1.640028');
    expect(avcCodecString('main', 0x28)).toBe('avc1.4d0028');
    expect(avcCodecString('baseline', 0x1e)).toBe('avc1.42e01e');
  });

  it('formats VP9 as vp09.00.LL.08', () => {
    expect(vp9CodecString('40')).toBe('vp09.00.40.08');
    expect(vp9CodecString('50')).toBe('vp09.00.50.08');
  });
});

describe('defaultBitrate', () => {
  it('scales with pixels*fps and honours a floor', () => {
    // 512^2 * 30 * 0.1 = 786432 -> clamped up to the 1 Mbit floor.
    expect(defaultBitrate(512, 512, 30)).toBe(1_000_000);
    expect(defaultBitrate(1080, 1080, 30)).toBe(3_499_200);
  });
});

describe('buildEncoderConfig', () => {
  it('orders H.264 (high/main/baseline) before the VP9 fallback', () => {
    const candidates = buildEncoderConfig({ width: 512, height: 512, fps: 30 });
    expect(candidates.map((c) => c.candidate.label)).toEqual([
      'H.264 high @ L3.0',
      'H.264 main @ L3.0',
      'H.264 baseline @ L3.0',
      'VP9 @ L3.0',
    ]);
    expect(candidates.map((c) => c.candidate.container)).toEqual(['mp4', 'mp4', 'mp4', 'webm']);
  });

  it('builds exact WebCodecs configs with AVCC format for H.264 only', () => {
    const [high, , , vp9] = buildEncoderConfig({ width: 1080, height: 1080, fps: 30 });
    expect(high!.config).toMatchObject({
      codec: 'avc1.640020',
      width: 1080,
      height: 1080,
      framerate: 30,
      latencyMode: 'realtime',
      avc: { format: 'avc' },
    });
    expect(high!.config.bitrate).toBe(defaultBitrate(1080, 1080, 30));
    // VP9 must not carry the AVC-specific config block.
    expect(vp9!.config.avc).toBeUndefined();
    expect(vp9!.config.codec).toBe('vp09.00.40.08');
  });

  it('passes an explicit bitrate through unchanged', () => {
    const [high] = buildEncoderConfig({ width: 512, height: 512, fps: 30, bitrate: 2_000_000 });
    expect(high!.config.bitrate).toBe(2_000_000);
  });
});

describe('preferWebmFirst', () => {
  // The full ordered candidate list is [H.264 high, main, baseline, VP9]; on Firefox
  // the worker moves the WebM candidate to the front to dodge the broken H.264 path.
  const items = buildEncoderConfig({ width: 512, height: 512, fps: 30 });

  it('moves WebM candidates ahead of MP4 ones', () => {
    const ordered = preferWebmFirst(items);
    expect(ordered[0]!.candidate.container).toBe('webm');
    expect(ordered.at(-1)!.candidate.container).toBe('mp4');
  });

  it('preserves the relative order within each container group (stable)', () => {
    const ordered = preferWebmFirst(items);
    const mp4Codecs = ordered
      .filter((c) => c.candidate.container === 'mp4')
      .map((c) => c.candidate.codec);
    const originalMp4 = items
      .filter((c) => c.candidate.container === 'mp4')
      .map((c) => c.candidate.codec);
    expect(mp4Codecs).toEqual(originalMp4);
  });

  it('does not mutate the input array', () => {
    const before = items.map((c) => c.candidate.codec);
    preferWebmFirst(items);
    expect(items.map((c) => c.candidate.codec)).toEqual(before);
  });

  it('is a no-op when there is nothing to reorder', () => {
    expect(preferWebmFirst([])).toEqual([]);
  });
});
