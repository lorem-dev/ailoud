import type { Segment, SpeakerName } from '../domain/model.js';

/** A speaker of one recording, as a reader of `show --speakers` sees them. */
export interface SpeakerSummary {
  /** What the diarizer called them. */
  readonly label: string;
  /** What a human called them, if anyone has. */
  readonly name: string | null;
  readonly segmentCount: number;
  readonly spokenMs: number;
}

/** Turns the stored pairs into a lookup, so callers do not each build one. */
export function speakerNameMap(names: readonly SpeakerName[]): ReadonlyMap<string, string> {
  return new Map(names.map((entry) => [entry.label, entry.name]));
}

/**
 * What to call a speaker on screen: their name if they have one, otherwise
 * the label the diarizer gave them.
 *
 * One function, so every place that prints a speaker agrees. The label is not
 * dropped from storage when a name exists -- see the speaker table's comment
 * -- so this is the only place the preference is expressed.
 */
export function speakerDisplayName(
  label: string | null,
  names: ReadonlyMap<string, string>,
): string | null {
  if (label === null) return null;
  return names.get(label) ?? label;
}

/**
 * Who spoke in a recording, how much, and what they are called.
 *
 * Ordered by speech, most first, rather than by label: "who did most of the
 * talking" is the question a reader actually has, and label order answers a
 * different one -- who the diarizer happened to number first.
 *
 * Includes named speakers that no segment mentions. A name left over from a
 * diarization run whose labels have since changed is worth showing rather
 * than hiding, because it is the evidence a reader needs to work out why
 * their annotation stopped taking effect.
 */
export function summarizeSpeakers(
  segments: readonly Segment[],
  names: readonly SpeakerName[],
): SpeakerSummary[] {
  const byLabel = new Map<string, { segmentCount: number; spokenMs: number }>();
  for (const segment of segments) {
    if (segment.speaker === null) continue;
    const seen = byLabel.get(segment.speaker) ?? { segmentCount: 0, spokenMs: 0 };
    seen.segmentCount += 1;
    // Clamp: a provider reporting an end before its start must not subtract
    // from a speaker's total and reorder the summary.
    seen.spokenMs += Math.max(0, segment.endMs - segment.startMs);
    byLabel.set(segment.speaker, seen);
  }

  const lookup = speakerNameMap(names);
  for (const entry of names) {
    if (!byLabel.has(entry.label)) byLabel.set(entry.label, { segmentCount: 0, spokenMs: 0 });
  }

  return (
    [...byLabel.entries()]
      .map(([label, totals]) => ({
        label,
        name: lookup.get(label) ?? null,
        segmentCount: totals.segmentCount,
        spokenMs: totals.spokenMs,
      }))
      // Most talking first; ties by label so the order is stable rather than
      // dependent on which segment happened to be seen first.
      .sort((a, b) => b.spokenMs - a.spokenMs || a.label.localeCompare(b.label))
  );
}

/**
 * The segments belonging to one speaker, chosen by label or by name.
 *
 * Accepts either because a reader who has just seen `show --speakers` has
 * both in front of them, and having to remember which one the flag wants is
 * friction for no reason. Matching is case-insensitive for the same reason
 * id prefixes are.
 */
export function segmentsOfSpeaker(
  segments: readonly Segment[],
  names: readonly SpeakerName[],
  wanted: string,
): Segment[] {
  const target = wanted.trim().toLowerCase();
  const labelsForName = names
    .filter((entry) => entry.name.toLowerCase() === target)
    .map((entry) => entry.label);
  const labels = new Set([target, ...labelsForName.map((label) => label.toLowerCase())]);
  return segments.filter(
    (segment) => segment.speaker !== null && labels.has(segment.speaker.toLowerCase()),
  );
}
