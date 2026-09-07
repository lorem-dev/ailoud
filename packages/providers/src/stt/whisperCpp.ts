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
 * Reads whisper's progress line, or returns null.
 *
 * MEASURED, not guessed, unlike the argument list below: `whisper-cli` with
 * `-pp` prints `whisper_print_progress_callback: progress =  46%` to stderr,
 * with variable padding before the number, and fires once per decoded
 * segment rather than on fixed steps. A 57-second fixture produced three
 * lines; an hour-long recording produces hundreds.
 *
 * Returns null rather than throwing for anything it does not recognise --
 * including a percentage outside 0..100. This runs on all ~104 stderr lines
 * of every run, and a parser that throws here would abort a transcription
 * over a cosmetic feature.
 */
export function parseProgressPercent(line: string): number | null {
  const match = /progress\s*=\s*(\d{1,3})%/.exec(line);
  if (match?.[1] === undefined) return null;
  const percent = Number(match[1]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return percent;
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
 * differ there, fix it here in this one place. `-pp` (print progress) is the
 * exception: it is measured against a real build, unlike the rest of this
 * list -- see parseProgressPercent above.
 */
function buildWhisperArgs(
  modelPath: string,
  audioPath: string,
  language: string | undefined,
  outputBase: string,
  threads: number,
  gpu: boolean,
): string[] {
  return [
    '-m',
    modelPath,
    '-f',
    audioPath,
    '-l',
    language ?? 'auto',
    '-t',
    String(threads),
    // -p (processors) is deliberately left at the binary's own 1. It decodes
    // N independent chunks in parallel and loses context at every boundary,
    // which trades accuracy for speed -- not the trade this feature is for.
    ...(gpu ? [] : ['-ng']),
    '-oj',
    '-pp',
    '-of',
    outputBase,
  ];
}

export interface WhisperCppOptions {
  readonly binary: string;
  readonly modelPath: string;
  /**
   * Threads for the CPU side of the run. Required, with no fallback: the
   * binary's own default is 4 whatever the machine has, and an adapter
   * quietly accepting that is how this went unnoticed. The number belongs to
   * the resource budget (core/resources/budget.ts), not here.
   *
   * Worth knowing before tuning it: on a build with a GPU backend this
   * barely matters. MEASURED on an M1 Pro, 607 s of speech: 16.56 s at -t 4,
   * 16.33 s at 6, 16.23 s at 8 -- two percent across the range, because the
   * encoder runs on Metal. On a CPU-only build the same flag is worth several
   * times the runtime, which is why it is still passed.
   */
  readonly threads: number;
  /**
   * False adds `-ng`. True adds nothing at all: a homebrew whisper-cli
   * already loads Metal on its own (measured), so using the GPU is the
   * default behaviour and this flag exists only to turn it off.
   */
  readonly gpu: boolean;
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
    opts: {
      readonly language?: string;
      readonly model?: string;
      readonly onProgress?: (fraction: number) => void;
    },
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
    const args = buildWhisperArgs(
      modelPath,
      audioPath,
      opts.language,
      outputBase,
      this.options.threads,
      this.options.gpu,
    );

    // Six hours, not the run helper's half-hour default: a long recording on
    // CPU-only whisper is genuinely slow, and the default would kill real work.
    const result = await this.runner(this.options.binary, args, {
      timeoutMs: 6 * 60 * 60_000,
      ...(opts.onProgress === undefined
        ? {}
        : {
            onStderrLine: (line) => {
              const percent = parseProgressPercent(line);
              if (percent === null) return;
              // run() already swallows a throwing sink; this try is here so
              // the guarantee holds for any future caller of the parser too.
              try {
                opts.onProgress?.(percent / 100);
              } catch {
                // An observer does not get to fail a transcription.
              }
            },
          }),
    });

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
      [
        '-m',
        modelPath,
        '-f',
        audioPath,
        '-t',
        String(this.options.threads),
        ...(this.options.gpu ? [] : ['-ng']),
        '-dl',
      ],
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
