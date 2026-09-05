import { readFile as readFileFromDisk } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { RawSegment, TranscriptionProvider } from '@ailoud/core';
import { FailureError } from '@ailoud/core';
import { run as defaultRunner } from '../process/run.js';

// NOT VERIFIED AGAINST A REAL BUILD: this JSON shape ("-oj" output: a
// top-level "result.language" and a "transcription" array of segments with
// "offsets.from"/"offsets.to" and "text") is written against whisper.cpp's
// documented output, with no whisper-cli binary available in this
// environment to confirm it against a real run. See buildWhisperArgs below
// for the sibling warning on the argument list; both get confirmed by the
// end-to-end suite once it runs against a real binary.
interface WhisperJson {
  result?: { language?: string };
  transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }>;
}

/**
 * Pulls the language out of `whisper-cli -dl` output. The line arrives on
 * stderr amid backend chatter, so this matches rather than reads a field.
 */
export function parseDetectedLanguage(output: string): string {
  const match = /auto-detected language:\s*([a-z]{2,3})\b/i.exec(output);
  if (match?.[1] === undefined) {
    throw new FailureError(
      'whisper did not report a detected language; the output format may have changed',
    );
  }
  return match[1].toLowerCase();
}

/**
 * Pure parser for whisper-cli's "-oj" JSON output.
 *
 * Whisper prefixes every segment's text with a leading space, and emits
 * silent stretches of audio as a segment with blank (or whitespace-only)
 * text. Trimming and dropping those here keeps the quirk out of the
 * database, where it would otherwise resurface in every export and every
 * prompt built from stored segments.
 */
export function parseWhisperJson(raw: string): { language: string; segments: RawSegment[] } {
  const parsed = JSON.parse(raw) as WhisperJson;
  if (!Array.isArray(parsed.transcription)) {
    throw new FailureError('whisper produced no "transcription" array; the output format changed');
  }
  const segments: RawSegment[] = [];
  for (const entry of parsed.transcription) {
    const text = (entry.text ?? '').trim();
    if (text === '') continue;
    segments.push({
      startMs: entry.offsets?.from ?? 0,
      endMs: entry.offsets?.to ?? 0,
      text,
    });
  }
  return { language: parsed.result?.language ?? 'unknown', segments };
}

/**
 * Builds the whisper-cli argument array for one transcription run.
 *
 * NOT VERIFIED AGAINST A REAL BUILD: these flags (-m model path, -f input
 * file, -l language or "auto", -oj JSON output, -of output base path) are
 * written against whisper.cpp's documented command-line interface. No
 * whisper-cli binary is available in this environment to confirm them
 * against an actual build. The end-to-end suite runs against a real binary
 * and is where this argument list gets confirmed; if a flag turns out to
 * differ there, fix it here in this one place.
 */
function buildWhisperArgs(
  modelPath: string,
  audioPath: string,
  language: string | undefined,
  outputBase: string,
): string[] {
  return ['-m', modelPath, '-f', audioPath, '-l', language ?? 'auto', '-oj', '-of', outputBase];
}

export interface WhisperCppOptions {
  readonly binary: string;
  readonly modelPath: string;
  readonly runner?: typeof defaultRunner;
  readonly readFile?: (path: string) => Promise<string>;
}

export class WhisperCppProvider implements TranscriptionProvider {
  readonly name = 'whisper-cpp';
  readonly capabilities = {
    maxBytes: null,
    supportsDiarization: false,
    supportsLanguageHint: true,
    supportsLanguageDetection: true,
  } as const;

  private readonly runner: typeof defaultRunner;
  private readonly readFile: (path: string) => Promise<string>;

  constructor(private readonly options: WhisperCppOptions) {
    this.runner = options.runner ?? defaultRunner;
    this.readFile = options.readFile ?? ((path) => readFileFromDisk(path, 'utf8'));
  }

  async transcribe(
    audioPath: string,
    opts: { readonly language?: string; readonly model?: string },
  ): Promise<{ language: string; model: string; segments: RawSegment[] }> {
    // whisper-cli writes <outputBase>.json rather than printing to stdout.
    // Derived from the filename component only (node:path), not a bare regex
    // on the whole path: a regex anchored on "last dot in the string" matches
    // a dot inside a directory name too, so an extension-less file inside a
    // directory like "ailoud-1.2" would collapse to a sibling path outside that
    // directory and silently collide with another recording's output.
    // NOT VERIFIED AGAINST A REAL BUILD: that whisper-cli writes exactly
    // "<outputBase>.json" (not, say, "<outputBase>.json.txt" or a name that
    // depends on other flags) is likewise taken from documentation, not
    // confirmed against a real run; see the warning on buildWhisperArgs.
    const outputBase = join(dirname(audioPath), basename(audioPath, extname(audioPath)));
    const modelPath = opts.model ?? this.options.modelPath;
    const args = buildWhisperArgs(modelPath, audioPath, opts.language, outputBase);

    // Six hours, not the run helper's half-hour default: a long recording on
    // CPU-only whisper is genuinely slow, and the default would kill real work.
    const result = await this.runner(this.options.binary, args, { timeoutMs: 6 * 60 * 60_000 });

    if (result.code !== 0) {
      throw new FailureError(`whisper failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    }

    const outputPath = `${outputBase}.json`;
    let raw: string;
    try {
      raw = await this.readFile(outputPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new FailureError(
        `whisper reported success but ${outputPath} could not be read: ${reason}`,
      );
    }

    const parsed = parseWhisperJson(raw);
    return { ...parsed, model: basename(modelPath) };
  }

  async detectLanguage(audioPath: string, opts: { readonly model?: string } = {}): Promise<string> {
    // -dl exits after detecting, without transcribing. It costs about the
    // same as a short transcription because almost all of it is loading the
    // model; detection itself does not grow with clip length.
    const modelPath = opts.model ?? this.options.modelPath;
    const result = await this.runner(
      this.options.binary,
      ['-m', modelPath, '-f', audioPath, '-dl'],
      { timeoutMs: 10 * 60_000 },
    );
    if (result.code !== 0) {
      throw new FailureError(
        `whisper could not detect a language: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
    return parseDetectedLanguage(`${result.stdout}\n${result.stderr}`);
  }
}
