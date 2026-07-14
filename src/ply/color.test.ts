import { describe, it, expect } from 'vitest';
import {
  srgbToLinear,
  analyzeSource,
  autoGain,
  makeRawColor,
  pickSource,
  resolveColors,
  AUTO_TARGET,
  MAX_AUTO_GAIN,
  type ColorSettings,
} from './color.js';

/** Build an interleaved channel array where every point is the flat value `v`. */
function flat<T extends Uint8Array | Uint16Array>(count: number, v: number, Ctor: new (n: number) => T): T {
  const a = new Ctor(count * 3);
  a.fill(v);
  return a;
}

describe('srgbToLinear', () => {
  it('anchors 0 and 1 and matches the standard curve', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 6);
    // Mid-grey 0.5 sRGB decodes to ~0.214 linear.
    expect(srgbToLinear(0.5)).toBeCloseTo(0.2140, 3);
  });
});

describe('analyzeSource', () => {
  it('reports the highlight percentile of the per-point max channel', () => {
    // 100 points: 99 dim (10/255) and 1 bright (200/255). The 99.5th percentile
    // sits in the dim band, so a lone hot point does not define the white point.
    const data = new Uint8Array(100 * 3);
    for (let i = 0; i < 99; i++) data.fill(10, i * 3, i * 3 + 3);
    data.fill(200, 99 * 3, 100 * 3);
    const { robustMax } = analyzeSource(data, 255);
    expect(robustMax).toBeCloseTo(10 / 255, 6);
  });

  it('returns 0 for an empty source', () => {
    expect(analyzeSource(new Uint8Array(0), 255).robustMax).toBe(0);
  });
});

describe('autoGain', () => {
  it('lifts a dim highlight toward the target and never darkens', () => {
    expect(autoGain({ robustMax: 0.1 })).toBeCloseTo(AUTO_TARGET / 0.1, 6);
    // Already-bright sources are left alone (gain floored at 1, never < 1).
    expect(autoGain({ robustMax: 0.95 })).toBe(1);
    expect(autoGain({ robustMax: 1 })).toBe(1);
  });

  it('caps runaway gain for a near-black source', () => {
    expect(autoGain({ robustMax: 1e-9 })).toBe(MAX_AUTO_GAIN);
    expect(autoGain({ robustMax: 0 })).toBe(1);
  });
});

describe('pickSource', () => {
  const raw16 = makeRawColor({ rgb8: flat(4, 5, Uint8Array), rgb16: flat(4, 500, Uint16Array) });
  const raw8only = makeRawColor({ rgb8: flat(4, 5, Uint8Array) });

  it('prefers 16-bit for auto, 8-bit for faithful', () => {
    expect(pickSource(raw16, 'auto')).toBe('rgb16');
    expect(pickSource(raw16, 'faithful')).toBe('rgb8');
  });

  it('falls back to whatever source exists', () => {
    expect(pickSource(raw8only, 'auto')).toBe('rgb8');
  });

  it('returns none for off mode or missing colour', () => {
    expect(pickSource(raw16, 'off')).toBe('none');
    expect(pickSource(null, 'auto')).toBe('none');
  });
});

describe('resolveColors', () => {
  it('faithful 8-bit + unit gain is a plain sRGB->linear decode (CLI parity)', () => {
    const raw = makeRawColor({ rgb8: flat(1, 128, Uint8Array), rgb16: flat(1, 60000, Uint16Array) });
    const { colors, info } = resolveColors(raw!, { mode: 'faithful', brightness: 1 });
    expect(info.source).toBe('rgb8');
    expect(info.totalGain).toBe(1);
    expect(colors![0]).toBeCloseTo(srgbToLinear(128 / 255), 6);
  });

  it('faithful ignores the brightness slider', () => {
    const raw = makeRawColor({ rgb8: flat(1, 128, Uint8Array) });
    const dim = resolveColors(raw!, { mode: 'faithful', brightness: 0.2 });
    const bright = resolveColors(raw!, { mode: 'faithful', brightness: 4 });
    expect(dim.colors![0]).toBe(bright.colors![0]);
  });

  it('auto brightens a dim 16-bit source toward the target highlight', () => {
    // robustMax ~ 500/65535; auto should map that flat value near AUTO_TARGET.
    const raw = makeRawColor({ rgb16: flat(50, 500, Uint16Array) });
    const { colors, info } = resolveColors(raw!, { mode: 'auto', brightness: 1 });
    expect(info.source).toBe('rgb16');
    // The display-space value (pre sRGB-decode) should land near AUTO_TARGET.
    const linear = colors![0]!;
    // Invert the sRGB decode to recover the display value we targeted.
    const display = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    expect(display).toBeCloseTo(AUTO_TARGET, 2);
  });

  it('layers the brightness multiplier on top of auto and clamps to white', () => {
    const raw = makeRawColor({ rgb16: flat(50, 500, Uint16Array) });
    const base = resolveColors(raw!, { mode: 'auto', brightness: 1 });
    const pushed = resolveColors(raw!, { mode: 'auto', brightness: 4 });
    expect(pushed.info.totalGain).toBeCloseTo(base.info.totalGain * 4, 6);
    // 4x past a 0.9 target saturates to pure white (linear 1).
    expect(pushed.colors![0]).toBeCloseTo(1, 6);
  });

  it('off mode yields no colours', () => {
    const raw = makeRawColor({ rgb8: flat(4, 128, Uint8Array) });
    const res = resolveColors(raw!, { mode: 'off', brightness: 1 });
    expect(res.colors).toBeNull();
    expect(res.effectiveHasColors).toBe(false);
  });

  it('reuses a provided output buffer of the right length', () => {
    const raw = makeRawColor({ rgb8: flat(4, 128, Uint8Array) });
    const out = new Float32Array(4 * 3);
    const settings: ColorSettings = { mode: 'faithful', brightness: 1 };
    const res = resolveColors(raw!, settings, out);
    expect(res.colors).toBe(out);
  });

  it('allocates a fresh buffer when the provided one is the wrong size', () => {
    const raw = makeRawColor({ rgb8: flat(4, 128, Uint8Array) });
    const wrong = new Float32Array(3);
    const res = resolveColors(raw!, { mode: 'faithful', brightness: 1 }, wrong);
    expect(res.colors).not.toBe(wrong);
    expect(res.colors!.length).toBe(4 * 3);
  });
});
