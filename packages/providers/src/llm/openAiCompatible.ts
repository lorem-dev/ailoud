import type { Summarizer } from '@ailoud/core';
import { EnvironmentError, FailureError } from '@ailoud/core';
import { withoutTrailingSlashes } from '@ailoud/core';

/**
 * A hosted model does not get the hour a local one does. If a request has not
 * come back in five minutes it is not coming back, and a CLI hanging on a
 * network call is worse than one that says so.
 */
const REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface OpenAiCompatibleOptions {
  /** Base URL up to but not including `/chat/completions`. */
  readonly baseUrl: string;
  readonly model: string;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  /** Absent means the endpoint needs no key, which a local server usually does not. */
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
}

/** The one field of the response this needs, and what to say when it is missing. */
export function extractCompletion(body: unknown): string {
  const choices = (body as { choices?: { message?: { content?: unknown } }[] }).choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new FailureError(
      'the model returned no text. The response did not contain choices[0].message.content.',
    );
  }
  return content.trim();
}

/**
 * Any endpoint speaking OpenAI's chat-completions shape.
 *
 * One adapter rather than one per vendor, because that shape is what almost
 * everything speaks: OpenAI itself, most hosted alternatives, and -- usefully
 * -- local servers like llama.cpp's own `llama-server`, Ollama and LM Studio.
 * Someone who wants a bigger local model than spawning a process per request
 * can bear points this at their own server and needs no new code here.
 *
 * The key is never read from the config file. It comes from the environment,
 * because a config file is a thing people paste into issues and commit by
 * accident, and a leaked key is not a mistake ailoud should make easy.
 */
export class OpenAiCompatibleSummarizer implements Summarizer {
  public readonly name = 'openai-compatible';

  public get model(): string {
    return this.options.model;
  }
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: OpenAiCompatibleOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public get contextTokens(): number {
    return this.options.contextTokens;
  }

  public async complete(prompt: string): Promise<string> {
    const url = `${withoutTrailingSlashes(this.options.baseUrl)}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey === undefined
            ? {}
            : { authorization: `Bearer ${this.options.apiKey}` }),
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: this.options.maxOutputTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (error) {
      // An aborted request and an unreachable host both land here, and the
      // difference matters to whoever has to fix it.
      throw new EnvironmentError(
        controller.signal.aborted
          ? `${this.options.baseUrl} did not answer within ${REQUEST_TIMEOUT_MS / 60_000} minutes.`
          : `could not reach ${this.options.baseUrl}: ${
              error instanceof Error ? error.message : String(error)
            }`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The body usually says which of key, quota or model name is wrong,
      // and swallowing it would leave the user guessing between them.
      const detail = await response.text().catch(() => '');
      throw new FailureError(
        `${this.options.baseUrl} returned HTTP ${response.status}${
          detail === '' ? '' : `: ${detail.slice(0, 400)}`
        }`,
      );
    }

    return extractCompletion(await response.json());
  }
}
