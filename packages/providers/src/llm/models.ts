import { EnvironmentError, FailureError } from '@laud/core';

/** As elsewhere in this directory: a hosted call that has not answered in a minute is not going to. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Anthropic pages its model list. Bounded so a misbehaving `has_more` cannot loop forever. */
const MAX_PAGES = 10;

/** One model a provider says it will accept. */
export interface ModelOption {
  readonly id: string;
  /** What to show in the picker: the vendor's display name where it gives one, else the id. */
  readonly label: string;
}

/**
 * Model ids that are not chat models.
 *
 * OpenAI's `/v1/models` is a catalogue of everything on the account --
 * embeddings, speech, images, moderation -- with nothing in the response that
 * distinguishes them, so the filtering has to happen on the id. A denylist of
 * substrings rather than an allowlist of prefixes: a new `gpt-` chat model
 * should appear in the picker the day it ships, which an allowlist would
 * delay until someone remembered to widen it.
 */
const NOT_CHAT = [
  'embedding',
  'tts',
  'whisper',
  'dall-e',
  'moderation',
  'transcribe',
  'image',
  'realtime',
  'audio',
  'stt',
];

export function isChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !NOT_CHAT.some((marker) => lower.includes(marker));
}

async function getJson(url: string, headers: Record<string, string>, fetchImpl: typeof fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: controller.signal });
  } catch (error) {
    throw new EnvironmentError(
      controller.signal.aborted
        ? `${url} did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
        : `could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new FailureError(
      `${url} returned HTTP ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 300)}`}`,
    );
  }
  return (await response.json()) as unknown;
}

/**
 * The chat models an OpenAI-compatible endpoint will accept.
 *
 * Sorted newest-looking first only as far as the response allows: `created` is
 * a unix timestamp on OpenAI's own API, and absent on most compatible servers,
 * where the order is left as the server gave it.
 */
export async function listOpenAiModels(
  baseUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly ModelOption[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const body = (await getJson(
    url,
    apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
    fetchImpl,
  )) as { data?: { id?: unknown; created?: unknown }[] };
  const entries = (body.data ?? []).filter(
    (entry): entry is { id: string; created?: number } => typeof entry.id === 'string',
  );
  return entries
    .filter((entry) => isChatModel(entry.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((entry) => ({ id: entry.id, label: entry.id }));
}

/**
 * The models Anthropic's API will accept, newest first.
 *
 * Paginated with `after_id` rather than taking the first page: the response
 * carries `has_more`, and stopping at page one would quietly hide models from
 * the picker with nothing on screen to say so.
 */
export async function listAnthropicModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly ModelOption[]> {
  const root = `${baseUrl.replace(/\/+$/, '')}/models`;
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const collected: ModelOption[] = [];
  let after: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${root}?limit=100${after === undefined ? '' : `&after_id=${after}`}`;
    const body = (await getJson(url, headers, fetchImpl)) as {
      data?: { id?: unknown; display_name?: unknown }[];
      has_more?: unknown;
      last_id?: unknown;
    };
    for (const entry of body.data ?? []) {
      if (typeof entry.id !== 'string') continue;
      collected.push({
        id: entry.id,
        label: typeof entry.display_name === 'string' ? entry.display_name : entry.id,
      });
    }
    if (body.has_more !== true || typeof body.last_id !== 'string') break;
    after = body.last_id;
  }
  return collected;
}
