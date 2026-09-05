import { describe, expect, it, vi } from 'vitest';
import { EnvironmentError, FailureError } from '@ailoud/core';
import { isChatModel, listAnthropicModels, listOpenAiModels } from './models.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('isChatModel', () => {
  it('keeps chat models, including ones nobody has heard of yet', () => {
    // A denylist, not an allowlist: a new chat model should show up in the
    // picker the day it ships, not once someone widens a prefix list.
    for (const id of ['gpt-4o', 'gpt-5-turbo', 'o3-mini', 'some-future-chat-model']) {
      expect(isChatModel(id), id).toBe(true);
    }
  });

  it('drops what the same endpoint returns that cannot summarise', () => {
    // /v1/models is a catalogue of everything on the account, with nothing in
    // the response marking which are chat models.
    for (const id of [
      'text-embedding-3-small',
      'tts-1-hd',
      'whisper-1',
      'dall-e-3',
      'omni-moderation-latest',
      'gpt-4o-transcribe',
      'gpt-4o-realtime-preview',
    ]) {
      expect(isChatModel(id), id).toBe(false);
    }
  });
});

describe('listOpenAiModels', () => {
  it('returns the chat models, newest first', () => {
    const fetchImpl = async () =>
      json({
        data: [
          { id: 'gpt-4o-mini', created: 100 },
          { id: 'text-embedding-3-small', created: 400 },
          { id: 'gpt-5', created: 300 },
        ],
      });
    return expect(
      listOpenAiModels('https://api.openai.com/v1', 'k', fetchImpl as never),
    ).resolves.toEqual([
      { id: 'gpt-5', label: 'gpt-5' },
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
    ]);
  });

  it('asks the /models path, tolerating a trailing slash', async () => {
    let seen = '';
    await listOpenAiModels('https://api.openai.com/v1/', 'k', (async (url: string) => {
      seen = url;
      return json({ data: [] });
    }) as never);
    expect(seen).toBe('https://api.openai.com/v1/models');
  });

  it('sends a bearer token when there is one, and none for a local server', async () => {
    let headers: Record<string, string> = {};
    const capture = (async (_url: string, init: { headers: Record<string, string> }) => {
      headers = init.headers;
      return json({ data: [] });
    }) as never;
    await listOpenAiModels('http://localhost:11434/v1', 'k', capture);
    expect(headers['authorization']).toBe('Bearer k');
    await listOpenAiModels('http://localhost:11434/v1', undefined, capture);
    expect(headers['authorization']).toBeUndefined();
  });

  it('skips entries with no usable id rather than showing "undefined"', async () => {
    const fetchImpl = async () => json({ data: [{ object: 'model' }, { id: 'gpt-4o' }] });
    expect(await listOpenAiModels('u', 'k', fetchImpl as never)).toEqual([
      { id: 'gpt-4o', label: 'gpt-4o' },
    ]);
  });

  it('surfaces the HTTP status and body, which say whether the key is the problem', async () => {
    const failing = async () =>
      new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 });
    await expect(listOpenAiModels('u', 'bad', failing as never)).rejects.toThrow(FailureError);
    await expect(listOpenAiModels('u', 'bad', failing as never)).rejects.toThrow(
      /Incorrect API key/,
    );
  });

  it('reports an unreachable endpoint as an environment problem', async () => {
    const offline = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    await expect(listOpenAiModels('u', 'k', offline as never)).rejects.toThrow(EnvironmentError);
  });
});

describe('listAnthropicModels', () => {
  it('prefers the vendor display name over the raw id', async () => {
    const fetchImpl = async () =>
      json({ data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }], has_more: false });
    expect(
      await listAnthropicModels('https://api.anthropic.com/v1', 'k', fetchImpl as never),
    ).toEqual([{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }]);
  });

  it('authenticates the way Anthropic requires', async () => {
    let headers: Record<string, string> = {};
    await listAnthropicModels('https://api.anthropic.com/v1', 'secret', (async (
      _url: string,
      init: { headers: Record<string, string> },
    ) => {
      headers = init.headers;
      return json({ data: [], has_more: false });
    }) as never);
    expect(headers['x-api-key']).toBe('secret');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['authorization']).toBeUndefined();
  });

  it('follows pages, so no model is hidden with nothing on screen to say so', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return urls.length === 1
        ? json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' })
        : json({ data: [{ id: 'b' }], has_more: false });
    }) as never;
    expect(await listAnthropicModels('u', 'k', fetchImpl)).toEqual([
      { id: 'a', label: 'a' },
      { id: 'b', label: 'b' },
    ]);
    expect(urls[1]).toContain('after_id=a');
  });

  it('stops when has_more is true but no cursor comes back, instead of looping', async () => {
    const fetchImpl = vi.fn(async () => json({ data: [{ id: 'a' }], has_more: true }));
    expect(await listAnthropicModels('u', 'k', fetchImpl as never)).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('cannot loop forever on a cursor that never advances', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ data: [{ id: 'a' }], has_more: true, last_id: 'same' }),
    );
    await listAnthropicModels('u', 'k', fetchImpl as never);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(10);
  });
});
