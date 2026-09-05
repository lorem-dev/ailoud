import type { Recording, Segment, SpeakerName } from '../domain/model.js';
import { speakerNameMap } from '../transcribe/speakers.js';
import { chunkTranscript, transcriptLine } from './chunk.js';
import { transcriptFileHeader, transcriptFileName } from './transcriptFile.js';
import { DEFAULT_TEMPLATE, findTemplate } from './templates.js';
import type { SummaryTemplate } from './templates.js';

/** One recording, with everything a summary needs to describe it. */
export interface SummarySource {
  readonly recording: Recording;
  readonly segments: readonly Segment[];
  readonly speakers: readonly SpeakerName[];
  /** The recording's tags, shown in the file header so the model can group by them. */
  readonly tags: readonly string[];
  /**
   * An earlier summary of this recording, used instead of its transcript.
   * Orders of magnitude cheaper for a group of ten meetings, and the map step
   * is not recomputed on every run.
   */
  readonly priorSummary?: string;
}

/** A transcript as it is written to the run's directory. */
export interface TranscriptFile {
  /** `record-yyyymmddhhmmss.txt`, unique within the run. */
  readonly name: string;
  /** The metadata header, a blank line, then the transcript. */
  readonly content: string;
  /** Which recording it came from, so a caller can map an answer back. */
  readonly recordingId: string;
}

export interface SummaryRequest {
  /** Every transcript, whole, to be written before the model is called. */
  readonly files: readonly TranscriptFile[];
  /**
   * One prompt per pass. A single entry when everything fits at once; several
   * when the material had to be fed in portions, each answered on its own.
   */
  readonly parts: readonly string[];
  /** How to fold several part answers into one. Empty when there is one part. */
  readonly combine: string;
}

export interface SummaryOptions {
  readonly budgetTokens: number;
  /** The language to answer in. Absent means "whatever the transcript is in". */
  readonly language?: string;
  /**
   * What kind of conversation this was, which decides the headings.
   * Absent means the default meeting shape.
   */
  readonly template?: SummaryTemplate;
  /**
   * A sentence or two of context from the person asking.
   *
   * The one thing a reader of the transcript knows that the model cannot:
   * who these people are to each other, what happened last week, what the
   * project is called. Kept short by convention rather than truncated --
   * every word here competes with the transcript for the model's attention.
   */
  readonly context?: string;
}

/**
 * A language name for a language code.
 *
 * The model is told "Write in Russian", not "Write in ru": a name is a word the
 * model has seen in instructions a great many times, and a two-letter code is
 * not. Anything unrecognised is passed through untouched, so `--lang
 * "plain English"` or a language with no entry here still works -- the map is
 * a courtesy for the codes people actually type, not a whitelist.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ru: 'Russian',
  uk: 'Ukrainian',
  pl: 'Polish',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  cs: 'Czech',
  tr: 'Turkish',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
  ar: 'Arabic',
  he: 'Hebrew',
  hi: 'Hindi',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code.trim().toLowerCase()] ?? code.trim();
}

/**
 * How many words the summary may run to.
 *
 * A cap is load-bearing rather than tidiness: measured across haiku, sonnet
 * and opus, an uncapped prompt ran to 270-330 words on a long transcript on
 * every run of the two larger models, and a summary nobody finishes reading
 * is not a summary. It scales with how much was handed over, because one cap
 * for both a single standup and ten meetings would be wrong for one of them.
 */
export function wordCap(sourceCount: number): number {
  return Math.min(600, 200 + 80 * Math.max(0, sourceCount - 1));
}

/**
 * What the model is told to do.
 *
 * Every line here was kept or cut on measured evidence, not taste: variants
 * were run three times each against six transcripts on haiku, sonnet and opus
 * (see `scripts/eval-summary-prompt.mjs`). Named headings beat a prose
 * instruction -- prose lost a stated fact on a code-switched transcript on
 * repeated sonnet runs, where the headings gave that fact somewhere to live.
 *
 * The language is named explicitly rather than left implicit. "In the language
 * of the transcript" is the default because ailoud exists for recordings that
 * are not in English, and a Russian meeting summarised into English is a
 * translation nobody asked for -- but `--lang` overrides it, because the
 * person reading the summary is not always the person who was in the room.
 */
export interface InstructionOptions {
  readonly language?: string;
  readonly cap: number;
  readonly template?: SummaryTemplate;
  readonly context?: string;
}

export function instruction(options: InstructionOptions): string {
  const template = options.template ?? findTemplate(DEFAULT_TEMPLATE)!;
  const { cap } = options;

  // The caller's context goes above the rules, not below them: it is what this
  // recording IS, and the rules are how to write about it. Below the rules it
  // read as one more constraint and was followed less often.
  const context =
    options.context === undefined || options.context.trim() === ''
      ? [template.context]
      : [template.context, `Context from the person asking: ${options.context.trim()}`];

  return [
    'Summarise the recordings below.',
    '',
    ...context,
    '',
    'Each transcript starts with a header: its title, when it was recorded, its tags and',
    'who took part. Use them. With more than one recording, say which one a point came from.',
    '',
    `Write in ${options.language ?? 'the language the transcript is in'}.`,
    'Use only what is in the transcripts and the context above -- nothing else you know.',
    'Name the speaker for each point the transcript attributes. Where it attributes none, state',
    'the point on its own -- do not invent a speaker and do not note that there was none.',
    `No preamble, no closing line, no commentary on the transcript. Under ${cap} words.`,
    '',
    'Use exactly these headings, omitting any that would be empty:',
    ...template.headings,
  ].join('\n');
}

/** The reduce step, when the material did not fit in one pass. */
function combineInstruction(language: string | undefined, cap: number): string {
  return [
    'Below are summaries of consecutive portions of the same material.',
    'Combine them into one summary, under the same headings.',
    `Write in ${language ?? 'the language they are written in'}.`,
    `Remove repetition. Add nothing new. Under ${cap} words.`,
  ].join(' ');
}

/** The whole transcript of one source, as its file will hold it. */
export function transcriptFileFor(source: SummarySource, name: string): TranscriptFile {
  const names = speakerNameMap(source.speakers);
  const body =
    source.priorSummary === undefined
      ? source.segments.map((segment) => transcriptLine(segment, names)).join('\n')
      : `(earlier summary of this recording, used in place of its transcript)\n\n${source.priorSummary}`;
  return {
    name,
    recordingId: source.recording.id,
    content: `${transcriptFileHeader(source)}\n\n${body}\n`,
  };
}

/** Names every source, none colliding, in the order they were given. */
export function transcriptFileNames(sources: readonly SummarySource[]): string[] {
  const taken = new Set<string>();
  return sources.map((source) => {
    const name = transcriptFileName(source.recording, taken);
    taken.add(name);
    return name;
  });
}

/**
 * Builds the request for one or several recordings.
 *
 * Several are summarised together rather than one at a time and stapled:
 * "what came out of these three conversations" is a different question from
 * three separate answers, and the second is what a user can already get by
 * running the command three times.
 *
 * When it all fits in `budgetTokens` there is one part. When it does not, the
 * transcripts are fed in portions and the answers folded together -- a model
 * cannot be shown what it cannot hold. The files are whole either way: what is
 * portioned is what goes into a request, not what is written to disk.
 */
export function buildSummaryRequest(
  sources: readonly SummarySource[],
  options: SummaryOptions,
): SummaryRequest {
  const cap = wordCap(sources.length);
  const head = instruction({
    ...(options.language === undefined ? {} : { language: languageName(options.language) }),
    cap,
    ...(options.template === undefined ? {} : { template: options.template }),
    ...(options.context === undefined ? {} : { context: options.context }),
  });
  const names = transcriptFileNames(sources);
  const files = sources.map((source, index) => transcriptFileFor(source, names[index]!));

  const blocks = sources.map((source, index) => {
    const chunks =
      source.priorSummary === undefined
        ? chunkTranscript(source.segments, speakerNameMap(source.speakers), options.budgetTokens)
        : [
            `(earlier summary of this recording, used in place of its transcript)\n\n${source.priorSummary}`,
          ];
    return { name: names[index]!, header: transcriptFileHeader(source), chunks };
  });

  const totalChunks = blocks.reduce((sum, block) => sum + block.chunks.length, 0);

  if (totalChunks <= 1) {
    const body = blocks
      .map((block) => `=== ${block.name} ===\n${block.header}\n\n${block.chunks[0] ?? ''}`)
      .join('\n\n');
    return { files, parts: [`${head}\n\n${body}`], combine: '' };
  }

  // One request per portion. The header is repeated on every portion, not only
  // the first: each is answered in its own request with no memory of the last,
  // so a portion without it is a transcript from nowhere, by nobody.
  const parts = blocks.flatMap((block) =>
    block.chunks.map((chunk, index) => {
      const of = block.chunks.length > 1 ? ` (portion ${index + 1} of ${block.chunks.length})` : '';
      return `${head}\n\n=== ${block.name}${of} ===\n${block.header}\n\n${chunk}`;
    }),
  );

  return {
    files,
    parts,
    combine: combineInstruction(
      options.language === undefined ? undefined : languageName(options.language),
      cap,
    ),
  };
}
