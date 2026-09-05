import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Summarizer } from '@ailoud/core';
import { FailureError } from '@ailoud/core';
import { run as defaultRunner } from '../process/run.js';

/**
 * Generation can legitimately take a long time on a laptop CPU: a few
 * thousand tokens from a 3B model is minutes, not seconds, and summarising a
 * long meeting is exactly that. A tighter bound would kill work that was
 * going to succeed.
 */
const COMPLETE_TIMEOUT_MS = 60 * 60_000;

export interface LlamaCppOptions {
  readonly binary: string;
  readonly modelPath: string;
  readonly contextTokens: number;
  /** Hard cap on the answer, so a model that starts looping cannot run forever. */
  readonly maxOutputTokens: number;
  readonly threads?: number;
  readonly runner?: typeof defaultRunner;
}

/**
 * Strips llama.cpp's own output from around the answer.
 *
 * With `-no-cnv --single-turn` the completion is what lands on stdout, but
 * some builds echo the prompt back before it. Trimming rather than parsing:
 * the output is prose, not a format, and a parser would be one more thing to
 * break on the next release.
 */
export function cleanCompletion(stdout: string, prompt: string): string {
  let text = stdout;
  const echoed = text.indexOf(prompt);
  if (echoed !== -1) text = text.slice(echoed + prompt.length);
  return text.trim();
}

/**
 * A local model, run the way whisper.cpp is: one binary, one GGUF file,
 * spawned per request.
 *
 * Per request rather than a resident server. It costs a model load each time
 * -- seconds for a 3B -- but a CLI that leaves a daemon running is a CLI that
 * then has to manage one, and nobody summarises in a tight loop.
 */
export class LlamaCppSummarizer implements Summarizer {
  public readonly name = 'llama.cpp';

  public get model(): string {
    return basename(this.options.modelPath);
  }
  private readonly runner: typeof defaultRunner;

  public constructor(private readonly options: LlamaCppOptions) {
    this.runner = options.runner ?? defaultRunner;
  }

  public get contextTokens(): number {
    return this.options.contextTokens;
  }

  public async complete(prompt: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ailoud-llm-'));
    const promptPath = join(dir, 'prompt.txt');
    try {
      return await this.completeFrom(prompt, promptPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async completeFrom(prompt: string, promptPath: string): Promise<string> {
    await writeFile(promptPath, prompt, 'utf8');
    const result = await this.runner(
      this.options.binary,
      [
        '-m',
        this.options.modelPath,
        '-c',
        String(this.options.contextTokens),
        '-n',
        String(this.options.maxOutputTokens),
        // A completion, not a chat session: anything interactive would sit
        // waiting for input that is never coming.
        '-no-cnv',
        '--single-turn',
        ...(this.options.threads === undefined ? [] : ['-t', String(this.options.threads)]),
        // -f rather than -p: a prompt carrying a transcript does not fit in an
        // argument. ARG_MAX is about a megabyte on macOS, less once the
        // environment is counted, and the spawn then fails with E2BIG -- a
        // failure the user can do nothing about.
        '-f',
        promptPath,
      ],
      { timeoutMs: COMPLETE_TIMEOUT_MS },
    );
    if (result.code !== 0) {
      throw new FailureError(
        `${this.name} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
    const text = cleanCompletion(result.stdout, prompt);
    if (text === '') {
      throw new FailureError(
        `${this.name} returned nothing. The transcript may be too large for the configured context.`,
      );
    }
    return text;
  }
}
