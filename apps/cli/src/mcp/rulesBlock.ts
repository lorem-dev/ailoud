import {
  blockRange as rangeIn,
  hasBlock as hasIn,
  withBlock as withIn,
  withoutBlock as withoutIn,
} from '../markerBlock.js';

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

/** The marker pair a rules file uses. Shell startup files use their own. */
const MARKERS = { start: START, end: END };

/**
 * What the agent is told.
 *
 * Short on purpose. This lands in a file that already carries the project's
 * own instructions, and a long block competes with them. It says the things
 * an agent gets wrong without being told: search instead of reading,
 * transcripts arrive as files, tag what is untagged, declare speakers and
 * languages before transcribing, and poll job_status instead of waiting.
 */
export function rulesBlock(): string {
  return [
    START,
    '## AILoud',
    '',
    'For questions about recordings, meetings, calls or transcripts, use AILoud rather than',
    'reading media or transcript files yourself:',
    '',
    '- **MCP tools** (prefer -- only these enforce the check below): `search_transcripts` finds where',
    '  something was said and returns the matching lines with timestamps and speakers -- reach for it',
    '  BEFORE `get_transcript`, which returns a file path rather than text precisely because a whole',
    '  transcript costs thousands of tokens. `list_recordings` orients you; `summarize` writes a',
    '  report, and `list_templates` first, because the headings differ by kind of conversation.',
    '- **Shell** (fallback -- skips it): `ailoud audio search "<words>"`, `ailoud audio ls`,',
    '  `ailoud audio summarize <id> --template <name>`.',
    '',
    'Tag recordings as you go (`--tag`, or `annotate`). Tags are the only way to ask for "the',
    'recordings about this project"; `list_untagged` shows what still needs one.',
    '',
    'Summaries take a short `context` -- who these people are, what the project is. AILoud does',
    'not remember it between calls, so keep it and pass it again.',
    '',
    'Before `transcribe`, ask the user how many people speak and in which languages, and offer',
    "your own guess from the recording's name. It decides the transcript's quality.",
    '',
    '`transcribe` and `summarize` return a job id: poll `job_status` with it, a few minutes',
    'apart, rather than waiting.',
    END,
  ].join('\n');
}

/** Where our block sits, or null. The pairing rule that matters lives in markerBlock.ts. */
export function blockRange(text: string): { readonly from: number; readonly to: number } | null {
  return rangeIn(text, MARKERS);
}

/** Whether a rules file already carries our block. */
export function hasBlock(text: string): boolean {
  return hasIn(text, MARKERS);
}

/** Inserts or replaces the block, returning the whole file. Why one blank line is what makes this idempotent lives in markerBlock.ts. */
export function withBlock(text: string, block = rulesBlock()): string {
  return withIn(text, block, MARKERS);
}

/** Removes the block, returning the whole file, or null when there was none. Why null and not the unchanged text lives in markerBlock.ts. */
export function withoutBlock(text: string): string | null {
  return withoutIn(text, MARKERS);
}
