import type { Recording } from '../domain/model.js';
import { formatRecordedAt, recordedOrImportedAt } from '../domain/recordedAt.js';
import { speakerNameMap } from '../transcribe/speakers.js';
import type { SummarySource } from './prompt.js';

/**
 * `record-yyyymmddhhmmss`, from the recording's own date.
 *
 * The date is in the name rather than only inside the file because the model
 * is handed several of these at once: the file names are the first thing it
 * reads about them, and "record-20260824093000" already answers "which meeting
 * is this and when" before a single line is parsed. Local time, matching the
 * header and every other date laud prints -- an ISO instant with a Z would be
 * a different time from the one the header shows, in the same directory.
 */
export function transcriptFileStem(recording: Recording): string {
  const at = new Date(recordedOrImportedAt(recording));
  if (!Number.isFinite(at.getTime())) return `record-${recording.id}`;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `record-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}

/**
 * A file name for this recording that is not already in `taken`.
 *
 * Two recordings can share a second -- a split file, a bulk import of
 * material whose metadata all carries the same timestamp -- and one silently
 * overwriting the other would drop a whole meeting out of the summary. The
 * suffix counts from 001 and the first file keeps the bare name, so the
 * common case reads cleanly and only a genuine collision pays for it.
 */
export function transcriptFileName(recording: Recording, taken: ReadonlySet<string>): string {
  const stem = transcriptFileStem(recording);
  if (!taken.has(`${stem}.txt`)) return `${stem}.txt`;
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${stem}-${String(n).padStart(3, '0')}.txt`;
    if (!taken.has(candidate)) return candidate;
  }
  // A thousand recordings in the same second is not a real library; fall back
  // to the id, which is unique by construction, rather than looping forever.
  return `${stem}-${recording.id}.txt`;
}

/**
 * The block at the top of every transcript file.
 *
 * The model is told in the instruction that this header exists and what it
 * means, so these labels are load-bearing and must not drift: a summary that
 * gets the date or the participants wrong is worse than one that omits them.
 * Every field is always present, "(none)" included -- an absent line reads as
 * "the header was truncated", while an explicit none is information.
 */
export function transcriptFileHeader(source: SummarySource): string {
  const { recording } = source;
  const names = speakerNameMap(source.speakers);
  // From the named speakers as well as the segments, not the segments alone: a
  // source reusing a stored summary carries no segments, and a header reading
  // "Participants: (not identified)" for a meeting whose speakers are all
  // named would throw away the annotation that makes the summary readable.
  const labels = [
    ...new Set([
      ...source.speakers.map((speaker) => speaker.label),
      ...source.segments.map((segment) => segment.speaker),
    ]),
  ].filter((label): label is string => label !== null);
  // A label with no name is listed, but marked. It has to appear: the
  // transcript lines below say "speaker_01:", so a model that never saw the
  // label cannot attribute anything to it. It has to be marked: the prompt
  // tells the model this line names who took part, and an unmarked
  // "speaker_01" there gets attributed as if it were somebody's name.
  const people = labels.map((label) => {
    const name = names.get(label);
    return name === undefined ? `${label} (unnamed)` : name;
  });

  return [
    `Title: ${recording.title ?? recording.sourcePath}`,
    `Recorded: ${formatRecordedAt(recordedOrImportedAt(recording))}`,
    `Tags: ${source.tags.length === 0 ? '(none)' : source.tags.join(', ')}`,
    `Participants: ${people.length === 0 ? '(not identified)' : people.join(', ')}`,
  ].join('\n');
}
