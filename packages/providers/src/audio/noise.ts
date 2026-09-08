import type { NoiseProfile } from '@ailoud/core';

/** What a measurement that produced nothing usable looks like. */
export const EMPTY_PROFILE: NoiseProfile = { noiseFloorDb: null, rmsDb: null };

/**
 * MEASURED against a real ffmpeg 8.0: astats prints its figures prefixed with
 * the filter instance, e.g.
 * `[Parsed_astats_0 @ 0x9348009c0] Noise floor dB: -43.303773`, on stderr.
 *
 * The value can also be the literal `-inf`, which is not an extreme number
 * but the absence of one: five of this project's eight fixtures report it.
 * Anything that is not a finite number becomes null here, so the decision
 * upstream sees "no measurement" rather than a value it would misread.
 */
const LEVEL_LINE = (label: string): RegExp =>
  new RegExp(`${label}\\s+dB:\\s*(-?[\\d.]+|-?inf)`, 'gi');

function lastFinite(output: string, label: string): number | null {
  let found: number | null = null;
  for (const match of output.matchAll(LEVEL_LINE(label))) {
    const raw = match[1];
    if (raw === undefined) continue;
    const value = Number(raw);
    // The LAST match, not the first: with per-channel measurement enabled a
    // channel's figures print before the overall ones, and the overall file
    // is what the decision is about. `measure_perchannel=none` means there is
    // only one today, but a flag change must not silently start reading one
    // channel as the whole recording.
    found = Number.isFinite(value) ? value : null;
  }
  return found;
}

export function parseNoiseProfile(output: string): NoiseProfile {
  return {
    rmsDb: lastFinite(output, 'RMS level'),
    noiseFloorDb: lastFinite(output, 'Noise floor'),
  };
}

/**
 * Scans a wav and prints its levels, writing no output file.
 *
 * Measured cost: 0.03-0.07 s per project fixture, roughly a thousand times
 * real time, so about three seconds for an hour of audio. That is what makes
 * measuring every recording affordable.
 */
export function astatsArgs(wavPath: string): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-i',
    wavPath,
    '-af',
    'astats=metadata=1:measure_overall=Noise_floor+RMS_level:measure_perchannel=none',
    '-f',
    'null',
    // The output target, and it is load-bearing. Without it ffmpeg answers
    // "At least one output file must be specified", exits non-zero and prints
    // no astats figures at all -- so every measurement comes back as two
    // nulls and `auto` silently never denoises anything. `-` is stdout, which
    // discards the samples because the format is null; nothing is written.
    '-',
  ];
}

/**
 * The denoising chain, deliberately conservative.
 *
 * `highpass=f=80` drops rumble below speech fundamentals. `afftdn=nf=-25` is
 * a mild FFT denoise. `arnndn` would be stronger and is not used: it needs a
 * model file downloaded and provisioned, which is a whole new layer for a
 * feature whose own measurements say five of eight fixtures never invoke it.
 *
 * The output shape matches `toWav16kMono`'s exactly, because this rewrites a
 * file that has already been converted and whisper must not notice a
 * difference beyond the filtering.
 */
export function denoiseArgs(input: string, output: string): string[] {
  return [
    '-v',
    'error',
    '-y',
    '-i',
    input,
    '-af',
    'highpass=f=80,afftdn=nf=-25',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    output,
  ];
}
