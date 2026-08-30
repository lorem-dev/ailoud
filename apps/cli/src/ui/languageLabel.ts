/**
 * How a transcript's language is shown to a person.
 *
 * A code-switched recording gets every language it contains, joined, rather
 * than a single dominant code -- "en" alone, for a recording that is half
 * Russian, is a false statement about what the user transcribed.
 *
 * `fallback` is the single code stored on the transcript, used when no
 * per-segment language was recorded. That is the normal case for a plain
 * (non-multilingual) transcription, and for anything transcribed before
 * per-segment languages existed.
 */
export function languageLabel(
  languages: readonly string[],
  fallback: string | null,
): string | null {
  return languages.length > 0 ? languages.join('+') : fallback;
}
