import { readFile as readFileFromDisk } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { RawSegment, TranscriptionProvider } from '@laud/core';
import { FailureError } from '@laud/core';
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
 * against an actual build. Task 17's end-to-end suite runs against a real
 * binary and is where this argument list gets confirmed; if a flag turns
 * out to differ there, fix it here in this one place.
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
    // Task 4 flips this to true when it implements detectLanguage.
    supportsLanguageDetection: false,
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
    // directory like "laud-1.2" would collapse to a sibling path outside that
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
}
