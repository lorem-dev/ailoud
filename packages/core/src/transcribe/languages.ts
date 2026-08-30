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
export function summarizeLanguages(segments: readonly Segment[]): readonly string[] {
  const spokenMsByLanguage = new Map<string, number>();
  for (const segment of segments) {
    const language = segment.language;
    if (language === null || language === '') continue;
    // Clamp: a provider reporting an end before its start must not subtract
    // duration from a language's total and reorder the result.
    const spokenMs = Math.max(0, segment.endMs - segment.startMs);
    spokenMsByLanguage.set(language, (spokenMsByLanguage.get(language) ?? 0) + spokenMs);
  }
  return [...spokenMsByLanguage.keys()].sort(
    (a, b) => (spokenMsByLanguage.get(b) ?? 0) - (spokenMsByLanguage.get(a) ?? 0),
  );
}
