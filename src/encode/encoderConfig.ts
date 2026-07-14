/**
 * Builds an ordered list of fully-qualified codec candidates for a given output
 * size / fps / bitrate, and probes them against `VideoEncoder.isConfigSupported`
 * (gpt #3).
 *
 * Ordering, best first:
 *   1. H.264 High profile   (avc1.64....)  -> MP4
 *   2. H.264 Main profile   (avc1.4d....)  -> MP4
 *   3. H.264 Constrained Baseline (avc1.42e0..) -> MP4
 *   4. VP9  profile 0       (vp09.00....)  -> WebM   (the Firefox/Linux fallback)
 *
 * The profile/level is chosen per resolution so the codec string is honest about
 * what the stream actually needs; a browser that lacks H.264 encode (a real risk
 * on headless Linux) simply falls through to the VP9 -> WebM candidate.
 */

export interface EncodeRequest {
  width: number;
  height: number;
  fps: number;
  /** Target bitrate in bits/sec. Derived from the geometry if omitted. */
  bitrate?: number;
}

export type Container = 'mp4' | 'webm';

/** A codec choice, independent of the exact WebCodecs config object. */
export interface CodecCandidate {
  container: Container;
  /** mediabunny's short codec id, passed to EncodedVideoPacketSource. */
  mediabunnyCodec: 'avc' | 'vp9';
  /** Fully-qualified codec string for WebCodecs, e.g. 'avc1.640028' or 'vp09.00.40.08'. */
  codec: string;
  /** Human-readable label for the support matrix. */
  label: string;
}

/** A candidate paired with the exact WebCodecs config it would use. */
export interface EncoderConfigCandidate {
  candidate: CodecCandidate;
  config: VideoEncoderConfig;
}

// --- H.264 (AVC) level table --------------------------------------------------
// MaxFS  = max frame size in macroblocks (16x16 px).
// MaxMBPS = max macroblocks per second.
// Values from ITU-T H.264 Table A-1. idc is the hex level_idc byte in avc1.PPCCLL.
interface AvcLevel {
  name: string;
  idc: number;
  maxFs: number;
  maxMbps: number;
}
const AVC_LEVELS: readonly AvcLevel[] = [
  { name: '3.0', idc: 0x1e, maxFs: 1620, maxMbps: 40500 },
  { name: '3.1', idc: 0x1f, maxFs: 3600, maxMbps: 108000 },
  { name: '3.2', idc: 0x20, maxFs: 5120, maxMbps: 216000 },
  { name: '4.0', idc: 0x28, maxFs: 8192, maxMbps: 245760 },
  { name: '4.2', idc: 0x2a, maxFs: 8704, maxMbps: 522240 },
  { name: '5.0', idc: 0x32, maxFs: 22080, maxMbps: 589824 },
  { name: '5.1', idc: 0x33, maxFs: 36864, maxMbps: 983040 },
  { name: '5.2', idc: 0x34, maxFs: 36864, maxMbps: 2073600 },
  { name: '6.0', idc: 0x3c, maxFs: 139264, maxMbps: 4177920 },
  { name: '6.2', idc: 0x3e, maxFs: 139264, maxMbps: 16711680 },
];

// --- VP9 level table ----------------------------------------------------------
// MaxLumaPictureSize (samples) and MaxLumaSampleRate (samples/sec) from the VP9
// bitstream spec, Annex A. code is the two-digit level in vp09.PP.LL.BD.
interface Vp9Level {
  name: string;
  code: string;
  maxPictureSize: number;
  maxSampleRate: number;
}
const VP9_LEVELS: readonly Vp9Level[] = [
  { name: '2.0', code: '20', maxPictureSize: 122880, maxSampleRate: 4608000 },
  { name: '2.1', code: '21', maxPictureSize: 245760, maxSampleRate: 9216000 },
  { name: '3.0', code: '30', maxPictureSize: 552960, maxSampleRate: 20736000 },
  { name: '3.1', code: '31', maxPictureSize: 983040, maxSampleRate: 36864000 },
  { name: '4.0', code: '40', maxPictureSize: 2228224, maxSampleRate: 83558400 },
  { name: '4.1', code: '41', maxPictureSize: 2228224, maxSampleRate: 160432128 },
  { name: '5.0', code: '50', maxPictureSize: 8912896, maxSampleRate: 311951360 },
  { name: '5.1', code: '51', maxPictureSize: 8912896, maxSampleRate: 588251136 },
  { name: '5.2', code: '52', maxPictureSize: 8912896, maxSampleRate: 1176502272 },
];

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** Smallest AVC level whose frame-size and macroblock-rate limits fit w x h @ fps. */
export function selectAvcLevel(width: number, height: number, fps: number): AvcLevel | null {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = mbs * fps;
  return AVC_LEVELS.find((l) => mbs <= l.maxFs && mbps <= l.maxMbps) ?? null;
}

/** Smallest VP9 level whose picture-size and sample-rate limits fit w x h @ fps. */
export function selectVp9Level(width: number, height: number, fps: number): Vp9Level | null {
  const samples = width * height;
  const rate = samples * fps;
  return VP9_LEVELS.find((l) => samples <= l.maxPictureSize && rate <= l.maxSampleRate) ?? null;
}

const AVC_PROFILE_IDC = { high: 0x64, main: 0x4d, baseline: 0x42 } as const;
type AvcProfile = keyof typeof AVC_PROFILE_IDC;

/**
 * avc1.PPCCLL: PP = profile_idc, CC = constraint flags, LL = level_idc.
 * Constrained Baseline sets constraint_set1 (0xe0 in the flags byte in practice);
 * High and Main use no constraint flags (0x00).
 */
export function avcCodecString(profile: AvcProfile, levelIdc: number): string {
  const constraint = profile === 'baseline' ? 0xe0 : 0x00;
  return `avc1.${hex2(AVC_PROFILE_IDC[profile])}${hex2(constraint)}${hex2(levelIdc)}`;
}

/** vp09.PP.LL.BD: profile 0, given level, 8-bit depth. */
export function vp9CodecString(levelCode: string): string {
  return `vp09.00.${levelCode}.08`;
}

/**
 * A reasonable default bitrate when the caller does not pin one: ~0.1 bits per
 * pixel per frame, which is a decent-quality H.264 operating point and errs high
 * enough that VP9 looks good too. Clamped to a sane floor.
 */
export function defaultBitrate(width: number, height: number, fps: number): number {
  return Math.max(1_000_000, Math.round(width * height * fps * 0.1));
}

/** Builds the exact WebCodecs config for a candidate. */
function toEncoderConfig(
  candidate: CodecCandidate,
  req: EncodeRequest,
  bitrate: number,
): VideoEncoderConfig {
  const config: VideoEncoderConfig = {
    codec: candidate.codec,
    width: req.width,
    height: req.height,
    bitrate,
    framerate: req.fps,
    // Realtime latency keeps decode order == presentation order (no B-frame
    // reordering), which the streaming muxer and index-derived timestamps rely on.
    latencyMode: 'realtime',
  };
  if (candidate.mediabunnyCodec === 'avc') {
    // AVCC (length-prefixed) so SPS/PPS ride in the decoder-config description
    // that mediabunny writes into the MP4, not inline Annex-B start codes (gpt #13).
    config.avc = { format: 'avc' };
  }
  return config;
}

/**
 * Ordered candidate list (best first) with each candidate's exact WebCodecs
 * config. Callers probe these in order via `pickSupportedConfig`.
 */
export function buildEncoderConfig(req: EncodeRequest): EncoderConfigCandidate[] {
  const bitrate = req.bitrate ?? defaultBitrate(req.width, req.height, req.fps);
  const candidates: CodecCandidate[] = [];

  const avc = selectAvcLevel(req.width, req.height, req.fps);
  if (avc) {
    const profiles: AvcProfile[] = ['high', 'main', 'baseline'];
    for (const profile of profiles) {
      candidates.push({
        container: 'mp4',
        mediabunnyCodec: 'avc',
        codec: avcCodecString(profile, avc.idc),
        label: `H.264 ${profile} @ L${avc.name}`,
      });
    }
  }

  const vp9 = selectVp9Level(req.width, req.height, req.fps);
  if (vp9) {
    candidates.push({
      container: 'webm',
      mediabunnyCodec: 'vp9',
      codec: vp9CodecString(vp9.code),
      label: `VP9 @ L${vp9.name}`,
    });
  }

  return candidates.map((candidate) => ({
    candidate,
    config: toEncoderConfig(candidate, req, bitrate),
  }));
}

export interface SupportProbe {
  candidate: CodecCandidate;
  config: VideoEncoderConfig;
  supported: boolean;
  /** The encoder's normalised config when supported (may reveal hw/sw choice). */
  resolvedConfig?: VideoEncoderConfig;
  error?: string;
}

/** Probes every candidate (for the support matrix), preserving order. */
export async function probeCandidates(req: EncodeRequest): Promise<SupportProbe[]> {
  const candidates = buildEncoderConfig(req);
  const results: SupportProbe[] = [];
  const hasApi =
    typeof VideoEncoder !== 'undefined' && typeof VideoEncoder.isConfigSupported === 'function';

  for (const { candidate, config } of candidates) {
    if (!hasApi) {
      results.push({ candidate, config, supported: false, error: 'VideoEncoder unavailable' });
      continue;
    }
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      results.push({
        candidate,
        config,
        supported: Boolean(support.supported),
        resolvedConfig: support.config,
      });
    } catch (err) {
      results.push({
        candidate,
        config,
        supported: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export interface PickedConfig {
  candidate: CodecCandidate;
  config: VideoEncoderConfig;
  resolvedConfig?: VideoEncoderConfig;
}

/**
 * First supported candidate in preference order, or null if none encode. An
 * optional `filter` narrows the candidates (e.g. to force the VP9/WebM path).
 */
export async function pickSupportedConfig(
  req: EncodeRequest,
  filter?: (candidate: CodecCandidate) => boolean,
): Promise<PickedConfig | null> {
  const probes = await probeCandidates(req);
  const hit = probes.find((p) => p.supported && (!filter || filter(p.candidate)));
  if (!hit) return null;
  return { candidate: hit.candidate, config: hit.config, resolvedConfig: hit.resolvedConfig };
}
