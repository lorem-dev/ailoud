import { createHash } from 'node:crypto';

/**
 * One path segment, safe to join onto a directory.
 *
 * Needed because a speaker name is user-supplied -- set through `annotate`,
 * then passed back in by an agent -- and it reached a `join()` unchecked.
 * `speaker: "../../../../tmp/PWNED"` made `get_transcript` write the
 * transcript to `/tmp/PWNED.txt`, outside the run's own directory: an
 * arbitrary file write driven by a tool argument.
 *
 * Anything outside a conservative set becomes `_`. A short hash of the
 * original is appended whenever that changed something, so two names that
 * sanitise alike -- "Ann/Bob" and "Ann Bob" -- still get different files
 * instead of silently overwriting each other.
 */
export function safePathComponent(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]/g, '_')
    // Runs of dots collapsed to one: `..` cannot escape anything inside a
    // single path segment, but a file called `__.._.._tmp_x` reads as though
    // something went wrong, and one dot carries the same information.
    .replace(/\.{2,}/g, '.')
    .replace(/^[._]+/, '_');
  const capped = cleaned.slice(0, 64);
  if (capped === raw) return capped;
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `${capped === '' ? 'x' : capped}-${digest}`;
}
