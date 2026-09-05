import type { Recording } from './model.js';

/**
 * The date to show for a recording: what its metadata says, or failing that
 * when ailoud imported it.
 *
 * One function, so the fallback is one rule rather than an `??` repeated at
 * every call site and drifting at one of them. The two fields stay separate in
 * storage precisely so this choice is made here and remains reversible; see
 * `Recording.recordedAt`.
 */
export function recordedOrImportedAt(recording: Recording): string {
  return recording.recordedAt ?? recording.importedAt;
}

/**
 * Normalises a container's creation-time tag to an ISO 8601 instant, or
 * rejects it.
 *
 * ffprobe hands back whatever the container held, and containers hold a lot
 * of things: `2024-03-15T10:23:45.000000Z` from an mp4, a bare local
 * timestamp from some cameras, and placeholders like `0000-00-00T00:00:00Z`
 * or the Unix epoch from tools that had nothing to write and wrote something
 * anyway.
 *
 * A placeholder is worse than nothing: null falls back to the import date,
 * which is at least true, whereas 1970 would be silently wrong and would sort
 * every such recording to the beginning of time. So anything unparseable, or
 * at or before the epoch, is refused rather than stored.
 *
 * Not checked: a date in the future, which a clock-skewed device can produce.
 * Deciding that needs a notion of now, and this module is in core, which does
 * no I/O and holds no clock. The caller has one and could pass it; nothing has
 * needed it yet, and inventing the parameter before the need would be
 * guessing at its shape.
 */
export function normalizeRecordedAt(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const parsed = new Date(trimmed);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) return null;
  // At or before the epoch: every tool that writes a placeholder writes one
  // of these, and none of them means "recorded on 1 January 1970".
  if (time <= 0) return null;
  return parsed.toISOString();
}

/**
 * The recording's date as a person reads it: `2024.03.15 10:23`.
 *
 * Local time, not UTC, and no seconds: this answers "which recording is
 * this" for someone who was in the room, and the second it started is not
 * how anyone remembers a meeting. An ISO instant is still what gets stored
 * and what `--format json` emits; this is only for the header.
 */
export function formatRecordedAt(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${at.getFullYear()}.${pad(at.getMonth() + 1)}.${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}
