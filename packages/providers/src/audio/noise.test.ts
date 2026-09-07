import { describe, expect, it } from 'vitest';
import { astatsArgs, denoiseArgs, EMPTY_PROFILE, parseNoiseProfile } from './noise.js';

/** Verbatim from a real run against fixtures/en-short.wav. */
const REAL_OUTPUT = [
  '[Parsed_astats_0 @ 0x9348009c0] RMS level dB: -16.167788',
  '[Parsed_astats_0 @ 0x9348009c0] Noise floor dB: -43.303773',
].join('\n');

/** Verbatim from a real run against fixtures/mixed-short.wav. */
const INF_OUTPUT = [
  '[Parsed_astats_0 @ 0xc85008fc0] RMS level dB: -15.377982',
  '[Parsed_astats_0 @ 0xc85008fc0] Noise floor dB: -inf',
].join('\n');

describe('parseNoiseProfile', () => {
  it('reads both levels from real astats output', () => {
    expect(parseNoiseProfile(REAL_OUTPUT)).toEqual({
      rmsDb: -16.167788,
      noiseFloorDb: -43.303773,
    });
  });

  it('turns -inf into null, not into a number', () => {
    // Five of this project's eight fixtures report -inf. Number('-inf') is
    // NaN and Number('-Infinity') is -Infinity; either one reaching
    // shouldDenoise as a value would denoise the cleanest files in the set.
    expect(parseNoiseProfile(INF_OUTPUT)).toEqual({
      rmsDb: -15.377982,
      noiseFloorDb: null,
    });
  });

  it('answers nulls for output with no levels at all', () => {
    expect(parseNoiseProfile('ffmpeg version 8.0')).toEqual(EMPTY_PROFILE);
  });

  it('answers nulls for empty output', () => {
    expect(parseNoiseProfile('')).toEqual(EMPTY_PROFILE);
  });

  it('takes the overall figure when a per-channel one precedes it', () => {
    // measure_perchannel=none is passed, but a future flag change must not
    // silently make this read a single channel as the whole file.
    const output = [
      '[Parsed_astats_0 @ 0x1] RMS level dB: -30.000000',
      '[Parsed_astats_0 @ 0x1] Noise floor dB: -50.000000',
      '[Parsed_astats_0 @ 0x1] Overall',
      '[Parsed_astats_0 @ 0x1] RMS level dB: -16.000000',
      '[Parsed_astats_0 @ 0x1] Noise floor dB: -43.000000',
    ].join('\n');
    expect(parseNoiseProfile(output)).toEqual({ rmsDb: -16, noiseFloorDb: -43 });
  });
});

describe('astatsArgs', () => {
  it('scans without writing a file', () => {
    const args = astatsArgs('/tmp/a.wav');
    expect(args).toContain('/tmp/a.wav');
    // -f null: this is a measurement, not a conversion. Writing an output
    // would double the cost of the cheapest step in the pipeline.
    expect(args.slice(-2)).toEqual(['-f', 'null']);
    expect(args.join(' ')).toContain('astats');
  });

  it('asks only for the two fields the decision uses', () => {
    expect(astatsArgs('/tmp/a.wav').join(' ')).toContain(
      'measure_overall=Noise_floor+RMS_level:measure_perchannel=none',
    );
  });
});

describe('denoiseArgs', () => {
  it('applies a high-pass and a mild fft denoise, in that order', () => {
    // highpass=f=80 removes rumble below speech fundamentals; afftdn=nf=-25
    // is deliberately mild. Anything stronger measurably costs accuracy on
    // audio that was not very noisy to begin with.
    expect(denoiseArgs('/tmp/in.wav', '/tmp/out.wav').join(' ')).toContain(
      '-af highpass=f=80,afftdn=nf=-25',
    );
  });

  it('keeps the 16 kHz mono pcm shape whisper is fed', () => {
    const args = denoiseArgs('/tmp/in.wav', '/tmp/out.wav').join(' ');
    expect(args).toContain('-ac 1');
    expect(args).toContain('-ar 16000');
    expect(args).toContain('-c:a pcm_s16le');
  });

  it('names the input and the output', () => {
    const args = denoiseArgs('/tmp/in.wav', '/tmp/out.wav');
    expect(args).toContain('/tmp/in.wav');
    expect(args[args.length - 1]).toBe('/tmp/out.wav');
  });
});
