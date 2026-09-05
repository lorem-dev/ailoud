import { quoteSample } from '@ailoud/core';
import type { Check } from './types.js';

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

/**
 * The status word for one check, in the three-state vocabulary `Check`
 * actually has: passed, failed, and failed-but-optional.
 *
 * `n/a`, not a second `FAIL`: `blocksReadiness` has always ignored an
 * optional failure, so an Intel Mac or Linux arm64 user could watch `setup
 * --yes` print red FAIL rows and then a green success frame with nothing
 * connecting the two. Rendering the same word for "ailoud cannot run" and "one
 * opt-in feature is unavailable" made the report contradict the exit code.
 * Lowercase like `ok` and unlike the shouted `FAIL`, because that is the
 * severity it carries. Four characters, so it fits both renderers' existing
 * status column without changing either width.
 *
 * Shared by PlainUi and PrettyUi so the two cannot drift into calling the
 * same state different things.
 */
export function checkStatus(check: Check): 'ok' | 'FAIL' | 'n/a' {
  if (check.ok) return 'ok';
  return check.optional === true ? 'n/a' : 'FAIL';
}

/**
 * The one line printed after a checklist that contains an unsatisfied
 * optional check, or null when there is none.
 *
 * The status word alone says a row is not fatal; it cannot say that the run
 * as a whole is fine, which is the question a reader staring at a
 * not-all-green list is actually asking. This says it once, in words, rather
 * than leaving them to infer it from the exit code.
 */
export function optionalNote(checks: readonly Check[]): string | null {
  const count = checks.filter((check) => !check.ok && check.optional === true).length;
  if (count === 0) return null;
  return (
    `${count} optional check${count === 1 ? '' : 's'} marked "n/a" above: an opt-in feature ` +
    'is unavailable until that is fixed, but ailoud does not need it to run.'
  );
}
