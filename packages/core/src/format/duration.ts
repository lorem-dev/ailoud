const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * How long something took, for a person reading a terminal.
 *
 * Units larger than seconds appear only once they are non-zero, so a quick
 * command reads `1.300s` rather than `0d 0h 0m 1.300s`, while a long one
 * reads `1d 5h 10m 1.300s`. Seconds are always present and always carry three
 * decimals: milliseconds are shown as thousandths of a second rather than as
 * a unit of their own, which keeps the tail of the string a fixed shape and
 * makes two timings easy to compare by eye.
 *
 * A negative or non-finite input is treated as zero. Durations here are
 * measured from a monotonic clock, so neither should occur, but a timing
 * display is not worth throwing over.
 */
export function formatDuration(totalMs: number): string {
  const ms = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 0;

  const days = Math.floor(ms / MS_PER_DAY);
  const hours = Math.floor(ms / MS_PER_HOUR) % 24;
  const minutes = Math.floor(ms / MS_PER_MINUTE) % 60;
  const seconds = (ms % MS_PER_MINUTE) / MS_PER_SECOND;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  // Once a larger unit is shown the smaller ones must be too, or "1d 5.000s"
  // would leave the reader wondering whether the hours and minutes were zero
  // or simply omitted.
  if (parts.length > 0 || hours > 0) parts.push(`${hours}h`);
  if (parts.length > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds.toFixed(3)}s`);
  return parts.join(' ');
}
