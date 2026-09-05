import type { Summarizer } from '@ailoud/core';
import { FailureError } from '@ailoud/core';
import { run as defaultRunner } from '../process/run.js';

/**
 * A hosted model reached through a local process. Longer than the direct API
 * adapters allow, because this one also pays for process startup and the
 * CLI's own session setup, but far short of the local model's hour.
 */
const COMPLETE_TIMEOUT_MS = 10 * 60_000;

export interface ClaudeCliOptions {
  readonly binary: string;
  /** A Claude Code alias such as "sonnet" or "opus", or a full model id. */
  readonly model: string;
  readonly contextTokens: number;
  readonly runner?: typeof defaultRunner;
}

/**
 * Claude through the Claude Code CLI, billed to the user's subscription.
 *
 * The reason this exists alongside the API adapter: a Claude subscription is
 * not an API key, and someone who pays for one should not have to pay twice to
 * summarise their own recordings. The CLI is already authenticated, so ailoud
 * borrows that rather than asking for a second credential.
 *
 * `--print` makes it answer and exit instead of opening a session. Tools are
 * switched off explicitly with an empty allow-list: this is a text completion,
 * and an agent that could read files or run commands while summarising a
 * transcript would be a much larger thing than the job asks for -- and would
 * do it in whatever directory ailoud happened to be run from.
 */
export class ClaudeCliSummarizer implements Summarizer {
  public readonly name = 'claude-cli';

  public get model(): string {
    return this.options.model;
  }
  private readonly runner: typeof defaultRunner;

  public constructor(private readonly options: ClaudeCliOptions) {
    this.runner = options.runner ?? defaultRunner;
  }

  public get contextTokens(): number {
    return this.options.contextTokens;
  }

  public async complete(prompt: string): Promise<string> {
    const result = await this.runner(
      this.options.binary,
      [
        '--print',
        '--model',
        this.options.model,
        // No tools. Summarising is a completion; an agent with file and shell
        // access is not what was asked for, and the transcript is not a task
        // for it to act on.
        '--allowed-tools',
        '',
      ],
      // On stdin rather than as an argument. A transcript of any length passes
      // ARG_MAX -- about a megabyte on macOS, less once the environment is
      // counted -- and the spawn then fails with E2BIG, which is not something
      // the user can fix.
      { timeoutMs: COMPLETE_TIMEOUT_MS, stdin: prompt },
    );

    if (result.code !== 0) {
      throw new FailureError(
        `${this.options.binary} failed: ${result.stderr.trim() || `exit ${result.code}`}. ` +
          'If it is not signed in, run it once on its own first.',
      );
    }
    const text = result.stdout.trim();
    if (text === '') {
      throw new FailureError(
        `${this.options.binary} returned nothing. Check that it is signed in by running it alone.`,
      );
    }
    return text;
  }
}
