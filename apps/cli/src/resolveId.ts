import { FailureError, UsageError } from '@laud/core';
import type { Recording, RecordingStore } from '@laud/core';

/**
 * The shortest prefix laud will resolve.
 *
 * One character over a base32 alphabet narrows almost nothing, and the cost
 * of the mistake is asymmetric: `laud rm 0` matching a single recording by
 * luck deletes the wrong one irreversibly. Two is the floor the user asked
 * for and the floor a person can still type without thinking.
 */
export const MIN_PREFIX_LENGTH = 2;

/** How many candidates an ambiguous prefix shows before it stops listing. */
const SHOWN_ON_AMBIGUITY = 3;

/**
 * Characters an id may contain.
 *
 * Deliberately wider than Crockford base32, which ULIDs actually use: the
 * point of validating here is that the prefix reaches a SQL LIKE, and neither
 * % nor _ can pass this. Excluding I, L, O and U as well would be precise
 * about today's id scheme and buy nothing -- a typo'd O for a zero simply
 * matches nothing, and "No recording matches" says that perfectly well.
 */
const ID_CHARS = /^[0-9A-Z]+$/;

/** One line identifying a candidate: the id, and something a human recognises. */
function describe(recording: Recording): string {
  return `  ${recording.id}  ${recording.title ?? recording.sourcePath}`;
}

/**
 * Turns an id prefix into the one recording it means, or explains why it
 * cannot.
 *
 * Ids are 26-character ULIDs and nobody wants to type one. As in docker, a
 * prefix will do, as long as it picks out exactly one recording.
 *
 * The ambiguous case is the one worth building carefully, because it is the
 * common one rather than the exception: a ULID begins with a timestamp, so
 * recordings imported minutes apart agree for eight characters or more. An
 * error that only said "ambiguous" would send the user back to `laud ls` to
 * work out what to type instead -- so it says how many matched and shows the
 * first few, which is usually enough to pick the right longer prefix without
 * looking anything up.
 *
 * Uppercased before matching: ULIDs are uppercase, and someone typing one by
 * hand should not have to be.
 */
export async function resolveRecording(store: RecordingStore, prefix: string): Promise<Recording> {
  const normalized = prefix.trim().toUpperCase();

  if (normalized.length < MIN_PREFIX_LENGTH) {
    throw new UsageError(
      `"${prefix}" is too short to identify a recording; use at least ${MIN_PREFIX_LENGTH} characters.`,
    );
  }
  if (!ID_CHARS.test(normalized)) {
    // Rejected rather than passed through to the query: punctuation cannot
    // appear in an id, and two of the characters it might be -- % and _ --
    // are wildcards in the LIKE this prefix ends up in.
    throw new UsageError(`"${prefix}" is not a recording id: ids are letters and digits only.`);
  }

  const matches = await store.findRecordingsByIdPrefix(normalized);

  const only = matches[0];
  if (only !== undefined && matches.length === 1) return only;

  if (matches.length === 0) {
    throw new FailureError(`No recording matches "${prefix}".`);
  }

  const shown = matches.slice(0, SHOWN_ON_AMBIGUITY).map(describe);
  const remainder = matches.length - shown.length;
  throw new FailureError(
    [
      `"${prefix}" matches ${matches.length} recordings:`,
      ...shown,
      ...(remainder > 0 ? [`  ...and ${remainder} more`] : []),
      'Use more characters to pick one.',
    ].join('\n'),
  );
}

/**
 * Resolves several prefixes, and refuses the whole set if any of them fails.
 *
 * All-or-nothing on purpose. The callers are `transcribe` and `rm`; for the
 * second, resolving three ids and acting on the two that worked would leave
 * a typo having half-deleted a library, with no undo.
 *
 * A prefix that resolves to a recording another prefix already picked is an
 * error too. `laud rm 01A 01AB` reads as two recordings and is one, and
 * silently deduplicating would report deleting one when the user asked for
 * two.
 */
export async function resolveRecordings(
  store: RecordingStore,
  prefixes: readonly string[],
): Promise<Recording[]> {
  const resolved: Recording[] = [];
  const seen = new Map<string, string>();
  for (const prefix of prefixes) {
    const recording = await resolveRecording(store, prefix);
    const earlier = seen.get(recording.id);
    if (earlier !== undefined) {
      throw new UsageError(
        `"${prefix}" and "${earlier}" are both the same recording (${recording.id}).`,
      );
    }
    seen.set(recording.id, prefix);
    resolved.push(recording);
  }
  return resolved;
}
