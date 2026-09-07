import { DENOISE_MODES, UsageError } from '@ailoud/core';
import type { DenoiseMode } from '@ailoud/core';

/**
 * Parses `--max-cpu`, shared by `transcribe` and `summarize` since both spawn
 * engines that read a thread budget.
 *
 * Validated here rather than left to the budget's own clamping, because this
 * is the boundary where a user's mistake should be told to them. The budget
 * silently falls back to the default instead, which is right for a library
 * caller and wrong for someone who typed a number.
 */
export function parseMaxCpu(value: string): number {
  const percent = Number(value);
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new UsageError(
      `--max-cpu takes a whole number of percent from 1 to 100, not "${value}".`,
    );
  }
  return percent;
}

/**
 * Parses `--denoise`. `transcribe` only: summarize reads stored transcripts,
 * not audio, so it has nothing to denoise.
 */
export function parseDenoise(value: string): DenoiseMode {
  const found = DENOISE_MODES.find((mode) => mode === value);
  if (found === undefined) {
    throw new UsageError(`--denoise takes ${DENOISE_MODES.join(', ')}, not "${value}".`);
  }
  return found;
}
