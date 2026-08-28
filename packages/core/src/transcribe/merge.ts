import type { SpeechSpan } from '../domain/ports.js';

/** A speech span with the language detection reported for it. */
export interface DetectedSpan extends SpeechSpan {
  readonly language: string;
}

/** A stretch to transcribe in one pass, in one language. */
export interface LanguageRun {
  readonly startMs: number;
  readonly endMs: number;
  readonly language: string;
}

/**
 * Below this, a span disagreeing with identical neighbours is treated as a
 * mis-detection rather than a real switch. A starting value, not a measured
 * one: long enough that detection had a full phrase to judge, short enough
 * that a genuine one-sentence switch survives. One constant, so measuring it
 * later changes one line.
 */
export const MIN_RUN_DURATION_MS = 1500;

/** Whether a span is too short to be believed against agreeing neighbours. */
function isNoise(span: DetectedSpan, before?: DetectedSpan, after?: DetectedSpan): boolean {
  if (before === undefined || after === undefined) return false;
  if (before.language !== after.language) return false;
  if (before.language === span.language) return false;
  return span.endMs - span.startMs < MIN_RUN_DURATION_MS;
}

/**
 * Groups detected spans into the runs the pipeline transcribes. Adjacent
 * spans sharing a language become one run and absorb the gap between them;
 * a change of language splits at the midpoint of the gap.
 */
export function mergeRuns(spans: readonly DetectedSpan[]): LanguageRun[] {
  if (spans.length === 0) return [];

  const kept = spans.filter((span, index) => !isNoise(span, spans[index - 1], spans[index + 1]));

  const runs: { startMs: number; endMs: number; language: string }[] = [];
  for (const span of kept) {
    const current = runs.at(-1);
    if (current !== undefined && current.language === span.language) {
      current.endMs = span.endMs;
      continue;
    }
    if (current !== undefined) {
      // Split the gap between two languages down the middle so neither side
      // clips the other's edge word.
      const boundary = Math.round((current.endMs + span.startMs) / 2);
      current.endMs = boundary;
      runs.push({ startMs: boundary, endMs: span.endMs, language: span.language });
      continue;
    }
    runs.push({ startMs: span.startMs, endMs: span.endMs, language: span.language });
  }
  return runs;
}
