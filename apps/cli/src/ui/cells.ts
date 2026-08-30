import { quoteSample } from '@laud/core';

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

/**
 * A transcript preview as it appears in a column beside other fields.
 *
 * Quoted and escaped (see quoteSample) so trailing whitespace is visible, an
 * empty transcript is distinguishable from a missing one, and a transcript
 * carrying control characters cannot reprogram the reader's terminal.
 *
 * An absent preview stays the empty string rather than becoming `""`: a
 * recording imported but not yet transcribed has no sample at all, and
 * showing empty quotes would claim it has one that happens to be blank.
 */
export function previewCell(preview: string): string {
  return preview === '' ? '' : quoteSample(preview);
}
