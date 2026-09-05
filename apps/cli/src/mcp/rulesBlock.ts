/**
 * The block AILoud writes into an agent's rules file.
 *
 * Markers rather than "append at the end": a rules file belongs to the user
 * and gets edited by hand, so the only safe way to update our own text is to
 * find exactly what we wrote last time and replace it. Everything outside the
 * markers is untouched on every install, update and uninstall.
 */
export const START = '<!-- AILOUD_START -->';
export const END = '<!-- AILOUD_END -->';

/**
 * What the agent is told.
 *
 * Short on purpose. This lands in a file that already carries the project's
 * own instructions, and a long block competes with them. It says the three
 * things an agent gets wrong without being told: search instead of reading,
 * transcripts arrive as files, and tag what is untagged.
 */
export function rulesBlock(): string {
  return [
    START,
    '## AILoud',
    '',
    'For questions about recordings, meetings, calls or transcripts, use AILoud rather than',
    'reading media or transcript files yourself:',
    '',
    '- **MCP tools** (when available): `search_transcripts` finds where something was said and',
    '  returns the matching lines with timestamps and speakers -- reach for it BEFORE',
    '  `get_transcript`, which returns a file path rather than text precisely because a whole',
    '  transcript costs thousands of tokens. `list_recordings` orients you; `summarize` writes a',
    '  report, and `list_templates` first, because the headings differ by kind of conversation.',
    '- **Shell** (always works): `ailoud audio search "<words>"`, `ailoud audio ls`,',
    '  `ailoud audio summarize <id> --template <name>`.',
    '',
    'Tag recordings as you go (`--tag`, or `annotate`). Tags are the only way to ask for "the',
    'recordings about this project"; `list_untagged` shows what still needs one.',
    '',
    'Summaries take a short `context` -- who these people are, what the project is. AILoud does',
    'not remember it between calls, so keep it and pass it again.',
    END,
  ].join('\n');
}

/** Whether a rules file already carries our block. */
export function hasBlock(text: string): boolean {
  return text.includes(START) && text.includes(END, text.indexOf(START));
}

/**
 * Inserts or replaces the block, returning the whole file.
 *
 * Appended with one blank line before it when absent, which is what makes the
 * result stable: running install twice produces the same bytes as running it
 * once, so `update` is safe to run on a schedule and a diff after it shows
 * only what actually changed.
 */
export function withBlock(text: string, block = rulesBlock()): string {
  if (!hasBlock(text)) {
    const base = text.trimEnd();
    return base === '' ? `${block}\n` : `${base}\n\n${block}\n`;
  }
  const start = text.indexOf(START);
  const end = text.indexOf(END, start) + END.length;
  return `${text.slice(0, start)}${block}${text.slice(end)}`;
}

/**
 * Removes the block, returning the whole file, or null when there was none.
 *
 * Null rather than the unchanged text so a caller can tell "removed" from
 * "there was nothing of ours here" and report the difference -- an uninstall
 * that claims to have cleaned a file it never touched teaches the user to
 * distrust it.
 */
export function withoutBlock(text: string): string | null {
  if (!hasBlock(text)) return null;
  const start = text.indexOf(START);
  const end = text.indexOf(END, start) + END.length;
  const before = text.slice(0, start).replace(/\n+$/, '');
  const after = text.slice(end).replace(/^\n+/, '');
  if (before === '' && after === '') return '';
  if (before === '') return `${after.trimEnd()}\n`;
  if (after === '') return `${before}\n`;
  return `${before}\n\n${after.trimEnd()}\n`;
}
