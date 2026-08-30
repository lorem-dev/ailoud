import type { Segment } from '../domain/model.js';

/**
 * The distinct languages a transcript's segments are spoken in, most-spoken
 * first.
 *
 * `Transcript.language` holds a single code, the dominant one, because the
 * column is non-nullable and machine consumers read it as one value. That is
 * the right thing to STORE and the wrong thing to SHOW for a code-switched
 * recording: reporting "en" for a recording that is half Russian states
 * something untrue to the person who just ran the command. Anything
 * rendering to a human uses this instead.
 *
 * Ordered by total spoken duration, not by first appearance, so the leading
 * entry is the same language `Transcript.language` holds. Ties keep the
 * order the languages first appear in -- Map preserves insertion order and
 * Array.prototype.sort is stable -- which keeps the output steady for a
 * recording that alternates evenly.
 *
 * Segments with no language recorded are skipped rather than grouped under
 * some placeholder: a provider that does not report per-segment language
 * should produce an empty result here, letting the caller fall back to
 * `Transcript.language`, not a list containing a fake entry.
 */
export interface LanguageTotal {
  readonly language: string;
  readonly spokenMs: number;
  /** Index of the language's first segment, used only to break duration ties. */
  readonly firstIdx: number;
}

/**
 * The ordering rule, in one place.
 *
 * Two callers need it: `summarizeLanguages`, which totals segments already in
 * memory, and the store, which totals them in SQL across many transcripts at
 * once so that listing a library does not mean loading every segment of every
 * recording. Expressing "most-spoken first, ties by first appearance" once in
 * SQL and once in TypeScript would be two statements of one rule, and they
 * would eventually disagree.
 */
export function orderLanguages(totals: readonly LanguageTotal[]): readonly string[] {
  return [...totals]
    .sort((a, b) => b.spokenMs - a.spokenMs || a.firstIdx - b.firstIdx)
    .map((total) => total.language);
}

export function summarizeLanguages(segments: readonly Segment[]): readonly string[] {
  const totals = new Map<string, { spokenMs: number; firstIdx: number }>();
  for (const segment of segments) {
    const language = segment.language;
    if (language === null || language === '') continue;
    // Clamp: a provider reporting an end before its start must not subtract
    // duration from a language's total and reorder the result.
    const spokenMs = Math.max(0, segment.endMs - segment.startMs);
    const seen = totals.get(language);
    if (seen === undefined) {
      totals.set(language, { spokenMs, firstIdx: segment.idx });
    } else {
      seen.spokenMs += spokenMs;
    }
  }
  return orderLanguages([...totals.entries()].map(([language, total]) => ({ language, ...total })));
}
