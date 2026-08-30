import type { Transcript } from '@laud/core';

/**
 * How a transcript's language is shown to a person.
 *
 * A code-switched recording gets every language it contains, joined, rather
 * than the single dominant code `Transcript.language` stores -- "en" alone,
 * for a recording that is half Russian, is a false statement about what the
 * user just transcribed.
 *
 * Falls back to the stored code when the provider recorded no per-segment
 * language, which is the normal case for a plain (non-multilingual)
 * transcription.
 */
export function languageLabel(transcript: Transcript, languages: readonly string[]): string {
  return languages.length > 0 ? languages.join('+') : transcript.language;
}
