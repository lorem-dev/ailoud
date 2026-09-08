import { describe, expect, it } from 'vitest';
import { DENOISE_MODES, NOISY_SNR_DB, shouldDenoise, snrDb } from './noise.js';

describe('snrDb', () => {
  it('subtracts the noise floor from the rms level', () => {
    expect(snrDb({ rmsDb: -16.17, noiseFloorDb: -43.3 })).toBeCloseTo(27.13, 2);
  });

  it('answers null when the floor is unavailable', () => {
    // -inf from ffmpeg arrives here as null, and five of the eight project
    // fixtures are this case. It is the common path, not an edge case.
    expect(snrDb({ rmsDb: -15.38, noiseFloorDb: null })).toBeNull();
  });

  it('answers null when the rms level is unavailable', () => {
    expect(snrDb({ rmsDb: null, noiseFloorDb: -40 })).toBeNull();
  });
});

describe('shouldDenoise', () => {
  it('never denoises in off mode, however noisy', () => {
    expect(shouldDenoise('off', { rmsDb: -22.18, noiseFloorDb: -38.53 })).toBe(false);
  });

  it('always denoises in on mode, however clean', () => {
    expect(shouldDenoise('on', { rmsDb: -16.17, noiseFloorDb: -43.3 })).toBe(true);
  });

  it('always denoises in on mode even with no measurement at all', () => {
    // "on" is an instruction, not a hypothesis: it must not depend on a
    // measurement that may have failed.
    expect(shouldDenoise('on', { rmsDb: null, noiseFloorDb: null })).toBe(true);
  });

  it('leaves audio with no measurable noise floor alone in auto mode', () => {
    // The mixed-short.wav case: ffmpeg reports -inf. That means nothing to
    // remove, never "infinitely noisy".
    expect(shouldDenoise('auto', { rmsDb: -15.38, noiseFloorDb: null })).toBe(false);
  });

  it('leaves audio with an unusable measurement alone in auto mode', () => {
    expect(shouldDenoise('auto', { rmsDb: null, noiseFloorDb: -38.94 })).toBe(false);
  });

  it('denoises the noisy fixture in auto mode', () => {
    // fixtures/noisy-short.wav, measured: 16.35 dB.
    expect(shouldDenoise('auto', { rmsDb: -22.18, noiseFloorDb: -38.53 })).toBe(true);
  });

  it('leaves the two clean measurable fixtures alone in auto mode', () => {
    // en-short.wav at 27.14 dB and ru-short.wav at 26.16 dB. These are the
    // regression this threshold exists to avoid.
    expect(shouldDenoise('auto', { rmsDb: -16.17, noiseFloorDb: -43.3 })).toBe(false);
    expect(shouldDenoise('auto', { rmsDb: -17.42, noiseFloorDb: -43.58 })).toBe(false);
  });

  it('keeps real margin on both sides of the threshold', () => {
    // Not a restatement of the constant: this asserts the gap the fixture
    // table actually measured, so tightening the threshold toward either
    // real fixture fails here rather than silently in production.
    expect(NOISY_SNR_DB - 16.35).toBeGreaterThan(4);
    expect(26.16 - NOISY_SNR_DB).toBeGreaterThan(4);
  });
});

describe('DENOISE_MODES', () => {
  it('lists every mode, for the CLI to validate against', () => {
    expect(DENOISE_MODES).toEqual(['auto', 'on', 'off']);
  });
});
