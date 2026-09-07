import type { NoiseProfile } from '../domain/ports.js';

export type DenoiseMode = 'auto' | 'on' | 'off';

/** Every accepted mode, in the order `--help` should list them. */
export const DENOISE_MODES: readonly DenoiseMode[] = ['auto', 'on', 'off'];

/**
 * The signal-to-noise ratio below which `auto` denoises.
 *
 * MEASURED, not chosen. Against this project's own fixtures, at 16 kHz mono:
 *
 *   noisy-short.wav   16.35 dB   must be denoised
 *   ru-short.wav      26.16 dB   must be left alone
 *   en-short.wav      27.14 dB   must be left alone
 *
 * 22 sits between them with 5.6 dB of margin below and 4.2 dB above. The
 * other five fixtures report no noise floor at all and never reach this
 * comparison. Moving this number is a measurement, not an opinion: rebuild
 * the table before touching it.
 */
export const NOISY_SNR_DB = 22;

export function snrDb(profile: NoiseProfile): number | null {
  const { rmsDb, noiseFloorDb } = profile;
  if (rmsDb === null || noiseFloorDb === null) return null;
  if (!Number.isFinite(rmsDb) || !Number.isFinite(noiseFloorDb)) return null;
  return rmsDb - noiseFloorDb;
}

/**
 * Whether to run the denoising chain over this file.
 *
 * `on` deliberately ignores the profile entirely: it is an instruction, and
 * making it depend on a measurement that may have failed would turn an
 * explicit request into a silent no-op.
 *
 * Every `auto` path that lacks evidence answers false. Denoising a clean
 * recording measurably costs accuracy, so "no usable measurement" must not
 * be read as "probably noisy".
 */
export function shouldDenoise(mode: DenoiseMode, profile: NoiseProfile): boolean {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  const snr = snrDb(profile);
  if (snr === null) return false;
  return snr < NOISY_SNR_DB;
}
