import { describe, expect, it } from 'vitest';
import { FailureError } from '@laud/core';
import { LlamaCppSummarizer, cleanCompletion } from './llamaCpp.js';
import { OpenAiCompatibleSummarizer, extractCompletion } from './openAiCompatible.js';

describe('cleanCompletion', () => {
  it('returns the answer, trimmed', () => {
    expect(cleanCompletion('  the summary  ', 'prompt')).toBe('the summary');
  });

  it('drops the prompt when the build echoes it back', () => {
    // Some llama.cpp builds print the prompt before the completion; the
    // answer is what comes after it.
    expect(cleanCompletion('Summarise this.\nthe summary', 'Summarise this.')).toBe('the summary');
  });

  it('leaves output alone when the prompt was not echoed', () => {
    expect(cleanCompletion('the summary', 'Summarise this.')).toBe('the summary');
  });
});

describe('LlamaCppSummarizer', () => {
  function runner(result: { code: number; stdout: string; stderr: string }) {
    const calls: readonly string[][] = [];
    const seen: string[][] = calls as string[][];
    return {
      seen,
      fn: async (_c: string, args: readonly string[]) => {
        seen.push([...args]);
        return result;
      },
    };
  }

  function make(runnerFn: unknown) {
    return new LlamaCppSummarizer({
      binary: 'llama-cli',
      modelPath: '/m.gguf',
      contextTokens: 8192,
      maxOutputTokens: 512,
      runner: runnerFn as never,
    });
  }

  it('returns the completion', async () => {
    const { fn } = runner({ code: 0, stdout: 'the summary', stderr: '' });
    expect(await make(fn).complete('p')).toBe('the summary');
  });

  it('asks for a completion, not a chat session', async () => {
    // Anything interactive would sit waiting for input that never comes.
    const { seen, fn } = runner({ code: 0, stdout: 'x', stderr: '' });
    await make(fn).complete('p');
    const args = seen[0]!.join(' ');
    expect(args).toContain('-no-cnv');
    expect(args).toContain('--single-turn');
  });

  it('passes the context and output caps through', async () => {
    const { seen, fn } = runner({ code: 0, stdout: 'x', stderr: '' });
    await make(fn).complete('p');
    const args = seen[0]!.join(' ');
    expect(args).toContain('-c 8192');
    expect(args).toContain('-n 512');
  });

  it('reports a non-zero exit with the reason', async () => {
    const { fn } = runner({ code: 1, stdout: '', stderr: 'failed to load model' });
    await expect(make(fn).complete('p')).rejects.toThrow(/failed to load model/);
  });

  it('treats empty output as a failure, naming the likely cause', async () => {
    // Silence here almost always means the prompt did not fit, and saying so
    // saves the user guessing.
    const { fn } = runner({ code: 0, stdout: '   ', stderr: '' });
    await expect(make(fn).complete('p')).rejects.toThrow(/too large for the configured context/);
  });
});

describe('extractCompletion', () => {
  it('reads the message content', () => {
    expect(extractCompletion({ choices: [{ message: { content: ' hi ' } }] })).toBe('hi');
  });

  it('says what was missing rather than throwing a type error', () => {
    expect(() => extractCompletion({})).toThrow(/choices\[0\].message.content/);
    expect(() => extractCompletion({ choices: [] })).toThrow(FailureError);
    expect(() => extractCompletion({ choices: [{ message: { content: '' } }] })).toThrow(
      FailureError,
    );
  });
});

describe('OpenAiCompatibleSummarizer', () => {
  function make(fetchImpl: unknown, apiKey?: string) {
    return new OpenAiCompatibleSummarizer({
      baseUrl: 'https://api.example.test/v1',
      model: 'gpt-test',
      contextTokens: 128_000,
      maxOutputTokens: 1024,
      ...(apiKey === undefined ? {} : { apiKey }),
      fetchImpl: fetchImpl as never,
    });
  }

  const ok = (content: string) => async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('returns the completion', async () => {
    expect(await make(ok('the summary')).complete('p')).toBe('the summary');
  });

  it('posts to chat/completions, tolerating a trailing slash on the base url', async () => {
    let seen = '';
    const capture = async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), {
        status: 200,
      });
    };
    const summarizer = new OpenAiCompatibleSummarizer({
      baseUrl: 'https://api.example.test/v1/',
      model: 'm',
      contextTokens: 1000,
      maxOutputTokens: 10,
      fetchImpl: capture as never,
    });
    await summarizer.complete('p');
    expect(seen).toBe('https://api.example.test/v1/chat/completions');
  });

  it('sends the key when there is one, and no header when there is not', async () => {
    let headers: Record<string, string> = {};
    const capture = async (_url: string, init: { headers: Record<string, string> }) => {
      headers = init.headers;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), {
        status: 200,
      });
    };
    await make(capture, 'secret').complete('p');
    expect(headers['authorization']).toBe('Bearer secret');

    // A local server usually needs none, and sending an empty bearer token is
    // worse than sending nothing.
    await make(capture).complete('p');
    expect(headers['authorization']).toBeUndefined();
  });

  it('surfaces the response body on an error status', async () => {
    // It is what says which of key, quota or model name is wrong.
    const failing = async () =>
      new Response('{"error":{"message":"invalid api key"}}', { status: 401 });
    await expect(make(failing).complete('p')).rejects.toThrow(/401/);
    await expect(make(failing).complete('p')).rejects.toThrow(/invalid api key/);
  });

  it('reports an unreachable host as an environment problem', async () => {
    const dead = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(make(dead).complete('p')).rejects.toThrow(/could not reach/);
  });
});
