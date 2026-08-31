import type { Recording, Segment, SpeakerName } from '../domain/model.js';
import { recordedOrImportedAt } from '../domain/recordedAt.js';
import { speakerNameMap } from '../transcribe/speakers.js';
import { chunkTranscript } from './chunk.js';

/** One recording, with everything a summary needs to describe it. */
export interface SummarySource {
  readonly recording: Recording;
  readonly segments: readonly Segment[];
  readonly speakers: readonly SpeakerName[];
}

export interface SummaryRequest {
  /** The instruction, already carrying the transcript. */
  readonly prompt: string;
  /** Present when the transcript had to be split; each is summarised alone first. */
  readonly parts: readonly string[];
}

/**
 * What the model is told to do.
 *
 * Kept short and specific. A long prompt full of hedging produces a summary
 * full of hedging, and every sentence added here is a sentence competing with
 * the transcript for the model's attention.
 *
 * "In the language of the transcript" rather than a fixed language: laud
 * exists for recordings that are not in English, and a Russian meeting
 * summarised into English is a translation nobody asked for. A transcript
 * that is genuinely bilingual gets whichever the model judges dominant, which
 * is the same answer `Transcript.language` gives.
 */
const INSTRUCTION = [
  'Summarise the transcript below.',
  'Write in the language the transcript is in.',
  'Lead with what was decided or concluded, if anything was.',
  'Attribute points to the speaker who made them, by the name shown.',
  'Do not invent anything that is not in the transcript.',
].join(' ');

/** Heads each transcript so the model can tell several recordings apart. */
export function sourceHeading(source: SummarySource): string {
  const { recording } = source;
  const title = recording.title ?? recording.sourcePath;
  return `--- ${title} (${recordedOrImportedAt(recording)}) ---`;
}

/**
 * Builds the request for one or several recordings.
 *
 * Several are summarised together rather than one at a time and stapled:
 * "what came out of these three conversations" is a different question from
 * three separate answers, and the second is what a user can already get by
 * running the command three times.
 *
 * When the whole thing fits in `budgetTokens`, `parts` is empty and `prompt`
 * is the entire job. When it does not, `parts` holds the pieces to summarise
 * separately and `prompt` is the instruction for combining those summaries --
 * map then reduce, because a model cannot be shown what it cannot hold.
 */
export function buildSummaryRequest(
  sources: readonly SummarySource[],
  budgetTokens: number,
): SummaryRequest {
  const blocks = sources.map((source) => {
    const names = speakerNameMap(source.speakers);
    const chunks = chunkTranscript(source.segments, names, budgetTokens);
    return { heading: sourceHeading(source), chunks };
  });

  const totalChunks = blocks.reduce((sum, block) => sum + block.chunks.length, 0);
  const single = totalChunks <= 1;

  if (single) {
    const body = blocks.map((block) => `${block.heading}\n${block.chunks[0] ?? ''}`).join('\n\n');
    return { prompt: `${INSTRUCTION}\n\n${body}`, parts: [] };
  }

  const parts = blocks.flatMap((block) =>
    block.chunks.map(
      (chunk, index) =>
        `${INSTRUCTION}\n\n${block.heading}` +
        `${block.chunks.length > 1 ? ` (part ${index + 1} of ${block.chunks.length})` : ''}\n` +
        chunk,
    ),
  );

  return {
    prompt:
      'Combine these partial summaries of the same material into one summary. ' +
      'Keep the language they are written in. Remove repetition. Do not add anything new.',
    parts,
  };
}
