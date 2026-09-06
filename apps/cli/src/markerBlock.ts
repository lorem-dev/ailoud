/**
 * A block of ailoud's own text inside a file that belongs to someone else.
 *
 * Markers rather than "append at the end": these files are hand-edited, so
 * the only safe way to update our own text is to find exactly what we wrote
 * last time and replace it. Everything outside the markers is untouched on
 * every write.
 *
 * Parameterised by the marker pair because two callers need it with
 * different comment syntax -- `<!-- ... -->` for a Markdown rules file,
 * `# ...` for a shell startup file -- and one implementation of the range
 * calculation below is the point. It has already been fixed once for a
 * defect that destroyed user text; a second copy is a second place for that
 * to come back.
 */
export interface Markers {
  readonly start: string;
  readonly end: string;
}

/**
 * Where our block sits, or null.
 *
 * The START taken is the LAST one before the first END, not the first one in
 * the file. Pairing the first START with the first END destroyed user text: a
 * file that merely MENTIONS the marker -- "we wrap our rules in <!--
 * AILOUD_START --> markers" -- made the range run from that sentence to the
 * end of our real block, and everything in between was replaced or deleted.
 */
export function blockRange(
  text: string,
  markers: Markers,
): { readonly from: number; readonly to: number } | null {
  const end = text.indexOf(markers.end);
  if (end === -1) return null;
  const from = text.lastIndexOf(markers.start, end);
  if (from === -1) return null;
  return { from, to: end + markers.end.length };
}

/** Whether a file already carries our block. */
export function hasBlock(text: string, markers: Markers): boolean {
  return blockRange(text, markers) !== null;
}

/**
 * Inserts or replaces the block, returning the whole file.
 *
 * Appended with one blank line before it when absent, which is what makes the
 * result stable: writing twice produces the same bytes as writing once, so a
 * refresh is safe to run on a schedule and a diff after it shows only what
 * actually changed.
 */
export function withBlock(text: string, block: string, markers: Markers): string {
  const range = blockRange(text, markers);
  if (range === null) {
    const base = text.trimEnd();
    return base === '' ? `${block}\n` : `${base}\n\n${block}\n`;
  }
  return `${text.slice(0, range.from)}${block}${text.slice(range.to)}`;
}

/**
 * Removes the block, returning the whole file, or null when there was none.
 *
 * Null rather than the unchanged text so a caller can tell "removed" from
 * "there was nothing of ours here" and report the difference -- an uninstall
 * that claims to have cleaned a file it never touched teaches the user to
 * distrust it.
 */
export function withoutBlock(text: string, markers: Markers): string | null {
  const range = blockRange(text, markers);
  if (range === null) return null;
  const before = text.slice(0, range.from).replace(/\n+$/, '');
  const after = text.slice(range.to).replace(/^\n+/, '');
  if (before === '' && after === '') return '';
  if (before === '') return `${after.trimEnd()}\n`;
  if (after === '') return `${before}\n`;
  return `${before}\n\n${after.trimEnd()}\n`;
}
