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
 * Serves two distinct purposes, which is worth knowing before changing it.
 *
 * In `subdivideSpans` it is a FLOOR on window length: equal division may not
 * produce a window shorter than this, because a very short window's
 * detection is worthless. That use wants a small number.
 *
 * In `mergeRuns` it is a NOISE THRESHOLD: a run shorter than this, sitting
 * between neighbours that agree with each other, is treated as a
 * mis-detection and absorbed. That use wants a number near one window.
 *
 * At the old 2000ms window the two coincided well enough at 1500. At the
 * current 5000ms window they no longer do, and the floor is the use that
 * must win: raising this to five seconds would leave
 * `floor(duration / 1500)` at one for most spans and stop subdivision from
 * happening at all, disabling the whole feature.
 *
 * The honest consequence, stated rather than hidden: with a 5000ms window,
 * every single-window run is 5000ms, so the `mergeRuns` absorption can now
 * only fire on a final partial window. The duration heuristic is no longer
 * the primary defence against a mis-detection --
 * `resolveDeclaredLanguages` is, whenever the caller declares which
 * languages are present. Absorption remains as a backstop for the
 * undeclared case.
 */
export const MIN_RUN_DURATION_MS = 1500;

/**
 * The longest a span may be before language detection runs on it as one
 * piece. A voice-activity segmenter cuts on silence; two clauses spoken back
 * to back with no measurable pause come back as a single span covering
 * both, and detecting that span as a whole reports only its first language.
 * Subdividing before detection gives `mergeRuns` something to cut on.
 *
 * Must stay strictly greater than `MIN_RUN_DURATION_MS` (1500ms):
 * `mergeRuns` absorbs a run shorter than that threshold when both its
 * neighbours agree with each other, treating it as a mis-detection. A
 * window at or below `MIN_RUN_DURATION_MS` would make every single-window
 * run absorbable, deleting a genuine one-window language switch -- exactly
 * what this feature exists to catch. At 2000ms against 1500ms a
 * single-window switch survives; at 1000ms it would not. `merge.test.ts`
 * pins this relationship with an assertion, not just this comment.
 *
 * 5000ms, and this one IS measured. The previous value, 2000ms, was chosen
 * as half of the 3.46-second fixture the feature was built against -- a
 * number fitted to a toy, which is exactly how it went wrong. Running
 * whisper's detector over spans of a real 32-second Russian/English
 * conversation:
 *
 *   entirely Russian span:  1s -> en, 2s -> pl, 3s -> pl, 4s -> pl,
 *                           5s -> ru, 6s -> ru
 *   span starting English:  2s -> en, 3s -> en, 5s -> ru
 *
 * Detection needs about five seconds of homogeneous speech to be right. At
 * 2000ms it reported Russian as Polish, and the run was then transcribed AS
 * Polish -- "Lucse kupi zaranee, utrom" came back as "Lutrzy kupi zaranie".
 *
 * The trade this buys is real and worth stating: conversational turns run
 * two to four seconds, so a five-second window frequently straddles two of
 * them -- which is what the last measurement above shows, an English span
 * reading as Russian once the window reached into the next turn. A wider
 * window is more reliable on homogeneous speech and less able to localise a
 * fast switch. `resolveDeclaredLanguages` exists because neither end of that
 * trade is good enough alone: when the caller knows which languages are
 * present, an out-of-set answer is knowably wrong regardless of window size.
 */
export const MAX_DETECTION_WINDOW_MS = 5000;

/**
 * The detection window to use when the caller HAS declared which languages
 * are present.
 *
 * Narrow, deliberately, and the opposite of what the unconstrained case
 * wants. The two settings answer different risks:
 *
 * Undeclared, a mis-detection is unrepairable -- nothing knows the answer is
 * wrong -- so the window must be wide enough for detection to be right,
 * which costs the ability to localise a fast switch.
 *
 * Declared, a mis-detection outside the set is knowable and gets repaired by
 * `resolveDeclaredLanguages`, so reliability is no longer what the window
 * has to buy. What it has to buy is resolution, because a window wider than
 * a conversational turn swallows whole turns of the other language.
 *
 * Measured on a 32-second Russian/English conversation of roughly
 * two-second turns, both runs with `--lang ru,en`:
 *
 *   5000ms window: 8 segments. Russian excellent, but five of the six
 *                  English turns vanished -- each window straddled two or
 *                  three turns, Russian won the window, and the English
 *                  inside it was transcribed as Russian.
 *   2000ms window: 12 segments. Every turn of both languages present, edges
 *                  of some phrases clipped. No Polish either way.
 *
 * Losing five turns outright is far worse than clipping edges, so declaring
 * a set buys back the narrow window that unconstrained detection cannot
 * afford.
 */
export const DECLARED_DETECTION_WINDOW_MS = 2000;

/**
 * Which window a run should use, given how many languages the caller
 * declared. One place, so the pipeline cannot pick one and a test another.
 */
export function detectionWindowMs(declaredCount: number): number {
  return declaredCount > 0 ? DECLARED_DETECTION_WINDOW_MS : MAX_DETECTION_WINDOW_MS;
}

/**
 * Splits any span longer than `windowMs` into windows of at most that
 * length, so per-window language detection has something to key a switch
 * on even when the segmenter returned one span for a whole recording. A
 * span no longer than the window passes through untouched -- including a
 * zero-length or negative-length one, which a segmenter should never
 * produce but this function does not assume. A longer span is divided into
 * equal-ish windows that exactly cover it -- not window-sized pieces with a
 * short remainder tacked on the end, which would make the last window's
 * detection unreliable.
 *
 * Invariant: no window this returns is shorter than `MIN_RUN_DURATION_MS`,
 * unless the input span itself is shorter than that (in which case it
 * passes through whole, unsplit, per the paragraph above). Equal division
 * into `ceil(duration / windowMs)` pieces can violate this whenever
 * `duration` is not a clean multiple of `windowMs` -- a 2500ms span at a
 * 2000ms window divides into two 1250ms pieces. A window that short is
 * exactly what `mergeRuns` treats as noise between agreeing neighbours, so
 * a genuine language switch inside it would be silently absorbed: the bug
 * this feature exists to remove. The fix is to cap the window count so
 * equal division cannot go below the floor, even if that leaves some
 * windows longer than `windowMs` -- a wide window only costs localisation
 * precision, not correctness.
 */
export function subdivideSpans(
  spans: readonly SpeechSpan[],
  windowMs: number = MAX_DETECTION_WINDOW_MS,
): SpeechSpan[] {
  const result: SpeechSpan[] = [];
  for (const span of spans) {
    const duration = span.endMs - span.startMs;

    // The widest window that still gives this span more than one detection.
    //
    // A fixed window is wrong at both ends. Too narrow and detection is
    // unreliable -- the measurements on MAX_DETECTION_WINDOW_MS. Too wide
    // and a short recording yields a single window, one detection, and the
    // feature silently does nothing: at a flat 5000ms the 3.46-second
    // bilingual clip this was built for stopped being split at all, and its
    // second language would have been lost again.
    //
    // So: prefer the widest reliable window, but never let it swallow a span
    // whole when that span is long enough to hold two runs. Halving is the
    // least assuming way to get two detections out of a short span; spans
    // too short to hold two runs still pass through untouched, because
    // splitting below the floor would only produce detections worth less
    // than the one it replaced.
    const effectiveWindowMs = Math.min(windowMs, Math.max(MIN_RUN_DURATION_MS, duration / 2));
    if (duration <= effectiveWindowMs) {
      result.push(span);
      continue;
    }

    const idealWindowCount = Math.ceil(duration / effectiveWindowMs);
    // Any more windows than this and equal division would drop below
    // MIN_RUN_DURATION_MS; at least one window regardless.
    const maxWindowCount = Math.floor(duration / MIN_RUN_DURATION_MS);
    const windowCount = Math.max(1, Math.min(idealWindowCount, maxWindowCount));
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

/**
 * Replaces detections that fall outside the languages the caller declared.
 *
 * whisper's detector always answers with exactly one language and cannot be
 * restricted to a candidate set, so a caller who knows the recording holds
 * only Russian and English has no way to say so up front. The constraint has
 * to be applied to the answer instead. When it reports Polish for a span of a
 * Russian/English conversation, that is not a discovery -- it is a
 * mis-detection, and a knowable one.
 *
 * A window whose language is out of set takes the language of the nearest
 * window that is in set, preferring the earlier one when both sides are
 * equally close: a speaker who has been talking usually keeps talking, and
 * ties must break the same way every run so the result does not depend on
 * which neighbour happened to be scanned first.
 *
 * If no window anywhere detected an in-set language the whole recording is
 * un-anchored, and the first declared language is used. That is a guess, but
 * a declared guess beats transcribing everything in a language the caller
 * has said is not present.
 *
 * Pure, and separate from `mergeRuns`, because the two answer different
 * questions: this one asks "is this answer even possible", using knowledge
 * only the caller has, while `mergeRuns` asks "is this answer plausible
 * given its neighbours", using duration. An empty declared set means the
 * caller declared nothing and every detection passes through untouched.
 */
export function resolveDeclaredLanguages(
  spans: readonly DetectedSpan[],
  declared: readonly string[],
): DetectedSpan[] {
  if (declared.length === 0) return [...spans];
  const allowed = new Set(declared);
  const inSet = spans.map((span) => allowed.has(span.language));
  if (!inSet.includes(true)) {
    const fallback = declared[0] ?? '';
    return spans.map((span) => ({ ...span, language: fallback }));
  }

  return spans.map((span, index) => {
    if (inSet[index] === true) return span;
    let before = -1;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (inSet[i] === true) {
        before = i;
        break;
      }
    }
    let after = -1;
    for (let i = index + 1; i < spans.length; i += 1) {
      if (inSet[i] === true) {
        after = i;
        break;
      }
    }
    // Ties go to the earlier neighbour; see the doc comment.
    const nearest =
      before === -1
        ? after
        : after === -1
          ? before
          : index - before <= after - index
            ? before
            : after;
    return { ...span, language: spans[nearest]?.language ?? declared[0] ?? span.language };
  });
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
