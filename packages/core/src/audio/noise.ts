import type { NoiseProfile } from '../domain/ports.js';

export type DenoiseMode = 'auto' | 'on' | 'off';

/** Every accepted mode, in the order `--help` should list them. */
export const DENOISE_MODES: readonly DenoiseMode[] = ['auto', 'on', 'off'];

/**
 * The signal-to-noise ratio below which `auto` denoises.
 *
 * MEASURED, not chosen. Against this project's own fixtures, at 16 kHz mono:
 *
 *   noisy-short.wav   16.35 dB   denoised
 *   ru-short.wav      26.16 dB   left alone
 *   en-short.wav      27.14 dB   left alone
 *
 * 22 sits between them with 5.6 dB of margin below and 4.2 dB above. The
 * other five fixtures report no noise floor at all and never reach this
 * comparison. Moving this number is a measurement, not an opinion: rebuild
 * the table before touching it.
 *
 * READ THIS BEFORE RELYING ON THE THRESHOLD. A benchmark on 2026-09-08 --
 * six corpora, eight whisper models, noise conditions from clean down to
 * 0 dB, about 26 paired comparisons resolved by bootstrap over clips --
 * found NO case where running the chain improved a transcript, and five
 * where it made one significantly worse. That is why `audio.denoise`
 * defaults to `off` and this comparison is normally never reached.
 *
 * Two things about the measurement itself are worth knowing:
 *
 *   - `RMS level - noise floor` is a proxy, not a signal-to-noise ratio. On
 *     pink noise the floor astats reports sits about 6 dB above the noise's
 *     own RMS, and the figure moves with clip length and with how much of a
 *     clip is silence.
 *   - It cannot see codec damage. A 24 kbit/s conference recording that
 *     sounds obviously degraded measured 32 dB here, and two of its three
 *     windows reported no floor at all.
 *
 * Where the threshold DOES fire on real audio -- a far-field meeting mic
 * measures 4 to 15 dB -- denoising changed the word error rate by 0.00
 * points for the default model and made `large-v3` significantly worse.
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
 * Every `auto` path that lacks evidence answers false. Denoising was
 * measured to cost accuracy on some material and to gain it on none, so
 * "no usable measurement" must not be read as "probably noisy" -- see
 * NOISY_SNR_DB above.
 */
export function shouldDenoise(mode: DenoiseMode, profile: NoiseProfile): boolean {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  const snr = snrDb(profile);
  if (snr === null) return false;
  return snr < NOISY_SNR_DB;
}
