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

/**
 * The longest a span may be before language detection runs on it as one
 * piece. A voice-activity segmenter cuts on silence; two clauses spoken back
 * to back with no measurable pause come back as a single span covering
 * both, and detecting that span as a whole reports only its first language.
 * Subdividing before detection gives `mergeRuns` something to cut on. Long
 * enough for whisper to judge a language correctly (an earlier probe
 * detected correctly from windows half this length); short enough to
 * localise a switch. One constant, so measuring it later changes one line.
 */
export const MAX_DETECTION_WINDOW_MS = 5000;

/**
 * Splits any span longer than `windowMs` into windows of at most that
 * length, so per-window language detection has something to key a switch
 * on even when the segmenter returned one span for a whole recording. A
 * span no longer than the window passes through untouched. A longer span is
 * divided into equal-ish windows that exactly cover it -- not window-sized
 * pieces with a short remainder tacked on the end, which would make the
 * last window's detection unreliable.
 */
export function subdivideSpans(
  spans: readonly SpeechSpan[],
  windowMs: number = MAX_DETECTION_WINDOW_MS,
): SpeechSpan[] {
  const result: SpeechSpan[] = [];
  for (const span of spans) {
    const duration = span.endMs - span.startMs;
    if (duration <= windowMs) {
      result.push(span);
      continue;
    }

    const windowCount = Math.ceil(duration / windowMs);
    const windowDuration = duration / windowCount;
    let start = span.startMs;
    for (let i = 0; i < windowCount; i += 1) {
      // The last window ends exactly at span.endMs rather than at a rounded
      // boundary, so rounding drift cannot leave a gap or an overlap.
      const end =
        i === windowCount - 1 ? span.endMs : span.startMs + Math.round((i + 1) * windowDuration);
      result.push({ startMs: start, endMs: end });
      start = end;
    }
  }
  return result;
}

interface IntermediateRun {
  readonly startMs: number;
  readonly endMs: number;
  readonly language: string;
  readonly spanStartIndex: number;
  readonly spanEndIndex: number;
}

/**
 * Groups detected spans into the runs the pipeline transcribes. Adjacent
 * spans sharing a language become one run and absorb the gap between them;
 * a change of language splits at the midpoint of the gap.
 *
 * Filters iteratively to convergence: build runs, identify and remove noisy
 * runs (both single noisy runs and chains of short runs between long ones),
 * then rebuild. Repeating until convergence ensures consecutive short spans
 * are absorbed, even when they have different languages.
 */
export function mergeRuns(spans: readonly DetectedSpan[]): LanguageRun[] {
  let current = [...spans];

  while (true) {
    // Build runs from current spans, tracking which spans contributed
    const runs: IntermediateRun[] = [];
    for (let i = 0; i < current.length; i += 1) {
      const span = current[i]!;
      const lastRun = runs.at(-1);

      if (lastRun !== undefined && lastRun.language === span.language) {
        // Extend last run; update spanEndIndex
        const extended = { ...lastRun, endMs: span.endMs, spanEndIndex: i };
        runs[runs.length - 1] = extended;
        continue;
      }

      if (lastRun !== undefined) {
        // Split the gap, then create a new run
        const boundary = Math.round((lastRun.endMs + span.startMs) / 2);
        const updated = { ...lastRun, endMs: boundary };
        runs[runs.length - 1] = updated;
        runs.push({
          startMs: boundary,
          endMs: span.endMs,
          language: span.language,
          spanStartIndex: i,
          spanEndIndex: i,
        });
        continue;
      }

      // First run
      runs.push({
        startMs: span.startMs,
        endMs: span.endMs,
        language: span.language,
        spanStartIndex: i,
        spanEndIndex: i,
      });
    }

    // Identify runs to remove: single noisy runs and chains of short runs
    const runsToRemove = new Set<number>();

    for (let i = 0; i < runs.length; i += 1) {
      const run = runs[i]!;
      const duration = run.endMs - run.startMs;

      // Rule 1: single noisy run (short and between identical neighbors)
      const before = runs[i - 1];
      const after = runs[i + 1];
      if (
        before !== undefined &&
        after !== undefined &&
        before.language === after.language &&
        before.language !== run.language &&
        duration < MIN_RUN_DURATION_MS
      ) {
        runsToRemove.add(i);
        continue;
      }

      // Rule 2: start of a chain of short runs between longer ones
      if (duration >= MIN_RUN_DURATION_MS) continue; // this run is long
      if (i === 0) continue; // first run cannot be a chain

      const prevRun = runs[i - 1]!;
      const prevDuration = prevRun.endMs - prevRun.startMs;
      if (prevDuration < MIN_RUN_DURATION_MS) continue; // previous is also short

      // run[i] is short and runs[i-1] is long: potential start of chain
      // Find where the chain of short runs ends
      let j = i;
      while (
        j + 1 < runs.length &&
        runs[j + 1]!.endMs - runs[j + 1]!.startMs < MIN_RUN_DURATION_MS
      ) {
        j += 1;
      }

      // runs[i..j] are all short. Check what comes after.
      const markCountBefore = runsToRemove.size;
      if (j + 1 < runs.length) {
        const nextRun = runs[j + 1]!;
        const nextDuration = nextRun.endMs - nextRun.startMs;
        if (nextDuration >= MIN_RUN_DURATION_MS && prevRun.language === nextRun.language) {
          // Chain is between two long runs of the same language; mark for removal
          for (let k = i; k <= j; k += 1) {
            runsToRemove.add(k);
          }
        }
      }

      // Only skip ahead if we actually marked runs. If the chain scan failed to
      // qualify (boundaries differ), let Rule 1 evaluate the first run normally.
      if (runsToRemove.size > markCountBefore) {
        i = j;
      }
    }

    if (runsToRemove.size === 0) {
      // Converged; build final runs without tracking
      const finalRuns: LanguageRun[] = [];
      for (const run of runs) {
        finalRuns.push({
          startMs: run.startMs,
          endMs: run.endMs,
          language: run.language,
        });
      }
      return finalRuns;
    }

    // Remove spans that contributed to noisy runs
    const spansToRemove = new Set<number>();
    for (const runIndex of runsToRemove) {
      const run = runs[runIndex]!;
      for (let i = run.spanStartIndex; i <= run.spanEndIndex; i += 1) {
        spansToRemove.add(i);
      }
    }

    current = current.filter((_, i) => !spansToRemove.has(i));
  }
}
