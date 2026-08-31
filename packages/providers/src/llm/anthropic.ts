import type { Summarizer } from '@laud/core';
import { EnvironmentError, FailureError } from '@laud/core';

/** As for the OpenAI adapter: a hosted call that has not returned in five minutes is not going to. */
const REQUEST_TIMEOUT_MS = 5 * 60_000;

/**
 * The API version header Anthropic requires on every request.
 *
 * Pinned, not omitted and not tracking the newest: the header is how Anthropic
 * keeps a client working when the API changes, and leaving it out or moving it
 * automatically would trade that guarantee away for nothing.
 */
const API_VERSION = '2023-06-01';

export interface AnthropicOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Pulls the text out of a messages response.
 *
 * The content is a list of blocks, not a string, because a reply can contain
 * more than prose. Only text blocks are joined; anything else is skipped
 * rather than stringified, which would put "[object Object]" in a summary.
 */
export function extractAnthropicText(body: unknown): string {
  const blocks = (body as { content?: { type?: string; text?: unknown }[] }).content;
  const text = (blocks ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
    .trim();
  if (text === '') {
    throw new FailureError(
      'Claude returned no text. The response contained no text blocks in content[].',
    );
  }
  return text;
}

/**
 * Claude, through Anthropic's own API.
 *
 * A separate adapter rather than a base-url swap on the OpenAI one, because
 * the two APIs are not the same shape: a different path, `x-api-key` instead
 * of a bearer token, a required version header, and a reply whose text lives
 * in a list of content blocks rather than in `choices[0].message.content`.
 * Pretending otherwise would have produced an adapter that looked generic and
 * worked for exactly one vendor.
 */
export class AnthropicSummarizer implements Summarizer {
  public readonly name = 'anthropic';

  public get model(): string {
    return this.options.model;
  }
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: AnthropicOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public get contextTokens(): number {
    return this.options.contextTokens;
  }

  public async complete(prompt: string): Promise<string> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/messages`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: this.options.maxOutputTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (error) {
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
      // The body distinguishes a bad key from an exhausted quota from an
      // unknown model name, and the user needs to know which.
      const detail = await response.text().catch(() => '');
      throw new FailureError(
        `Anthropic returned HTTP ${response.status}${
          detail === '' ? '' : `: ${detail.slice(0, 400)}`
        }`,
      );
    }

    return extractAnthropicText(await response.json());
  }
}
