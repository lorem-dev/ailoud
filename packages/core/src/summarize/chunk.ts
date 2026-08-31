import type { Segment } from '../domain/model.js';
import { formatTimestamp } from '../format/subtitles.js';
import { speakerDisplayName } from '../transcribe/speakers.js';

/**
 * Characters per token, for deciding when a transcript needs splitting.
 *
 * A deliberate under-estimate. English averages nearer four characters per
 * token, but Cyrillic and CJK are far denser -- a Russian word can cost a
 * token every two characters -- and this codebase's whole reason for existing
 * is recordings that are not in English. Guessing high would mean sending the
 * model more than its context holds, and being told so only after the work
 * had been done; guessing low costs one extra chunk on a long recording.
 */
const CHARS_PER_TOKEN = 2.5;

/** Rough token count for a piece of text. Never used for billing, only for splitting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * One line of transcript as the model sees it.
 *
 * The timestamp is kept because a summary that can say "they agreed at
 * 00:41:00" is worth more than one that cannot, and the speaker because
 * attributing a decision to a person is most of what a meeting summary is
 * for. This is also where the names a human set through `annotate` earn
 * their keep: the model reads "Ann" rather than "speaker_00".
 */
export function transcriptLine(segment: Segment, names: ReadonlyMap<string, string>): string {
  const who = speakerDisplayName(segment.speaker, names);
  const prefix = who === null ? '' : `${who}: `;
  return `[${formatTimestamp(segment.startMs, 'short')}] ${prefix}${segment.text}`;
}

/**
 * Splits a transcript into pieces small enough to send.
 *
 * Splits on segment boundaries and never inside one: a sentence cut in half
 * across two requests is a sentence the model summarises twice, badly, and
 * segments are already the natural seams of the recording.
 *
 * A single segment larger than the budget is emitted alone rather than
 * dropped or truncated. It will overflow, and the caller will be told by the
 * model -- which is a better failure than silently losing the longest thing
 * anyone said.
 */
export function chunkTranscript(
  segments: readonly Segment[],
  names: ReadonlyMap<string, string>,
  budgetTokens: number,
): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const segment of segments) {
    const line = transcriptLine(segment, names);
    const tokens = estimateTokens(line);
    if (current.length > 0 && currentTokens + tokens > budgetTokens) {
      chunks.push(current.join('\n'));
      current = [];
      currentTokens = 0;
    }
    current.push(line);
    currentTokens += tokens;
  }

  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}
