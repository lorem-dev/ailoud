import { describe, expect, it } from 'vitest';
import { FailureError } from '@ailoud/core';
import { LlamaCppSummarizer, cleanCompletion } from './llamaCpp.js';
import { OpenAiCompatibleSummarizer, extractCompletion } from './openAiCompatible.js';
import { AnthropicSummarizer, extractAnthropicText } from './anthropic.js';
import { ClaudeCliSummarizer } from './claudeCli.js';

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

describe('extractAnthropicText', () => {
  it('joins the text blocks', () => {
    expect(
      extractAnthropicText({
        content: [
          { type: 'text', text: 'one ' },
          { type: 'text', text: 'two' },
        ],
      }),
    ).toBe('one two');
  });

  it('skips blocks that are not text rather than stringifying them', () => {
    // JSON.stringify-ing a tool_use block would put "[object Object]" or a
    // blob of JSON in the middle of the user's summary.
    const text = extractAnthropicText({
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'the summary' },
      ],
    });
    expect(text).toBe('the summary');
  });

  it('fails loudly when there is no text at all', () => {
    expect(() => extractAnthropicText({ content: [] })).toThrow(FailureError);
    expect(() => extractAnthropicText({})).toThrow(/no text blocks/);
  });
});

describe('AnthropicSummarizer', () => {
  const reply = (text: string) =>
    new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });

  function make(fetchImpl: unknown) {
    return new AnthropicSummarizer({
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-test',
      contextTokens: 200_000,
      maxOutputTokens: 4096,
      apiKey: 'secret',
      fetchImpl: fetchImpl as never,
    });
  }

  it('returns the completion', async () => {
    expect(await make(async () => reply('the summary')).complete('p')).toBe('the summary');
  });

  it('posts to /messages, tolerating a trailing slash on the base url', async () => {
    let seen = '';
    const summarizer = new AnthropicSummarizer({
      baseUrl: 'https://api.anthropic.com/v1/',
      model: 'm',
      contextTokens: 1000,
      maxOutputTokens: 10,
      apiKey: 'k',
      fetchImpl: (async (url: string) => {
        seen = url;
        return reply('x');
      }) as never,
    });
    await summarizer.complete('p');
    expect(seen).toBe('https://api.anthropic.com/v1/messages');
  });

  it('authenticates the way Anthropic requires, not the way OpenAI does', async () => {
    // The whole reason this adapter is not a base-url swap on the OpenAI one.
    let headers: Record<string, string> = {};
    await make(async (_url: string, init: { headers: Record<string, string> }) => {
      headers = init.headers;
      return reply('x');
    }).complete('p');
    expect(headers['x-api-key']).toBe('secret');
    expect(headers['authorization']).toBeUndefined();
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('sends the prompt as a user message with a max_tokens cap', async () => {
    let body: { messages: { role: string; content: string }[]; max_tokens: number } = {
      messages: [],
      max_tokens: 0,
    };
    await make(async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return reply('x');
    }).complete('summarise this');
    expect(body.messages).toEqual([{ role: 'user', content: 'summarise this' }]);
    // Omitted, the API rejects the request outright.
    expect(body.max_tokens).toBe(4096);
  });

  it('surfaces the error body, which says whether the key or the quota is the problem', async () => {
    const failing = async () =>
      new Response('{"error":{"message":"credit balance is too low"}}', { status: 400 });
    await expect(make(failing).complete('p')).rejects.toThrow(/credit balance is too low/);
    await expect(make(failing).complete('p')).rejects.toThrow(/HTTP 400/);
  });
});

describe('ClaudeCliSummarizer', () => {
  function make(runner: unknown) {
    return new ClaudeCliSummarizer({
      binary: 'claude',
      model: 'sonnet',
      contextTokens: 200_000,
      runner: runner as never,
    });
  }

  const succeed = async () => ({ code: 0, stdout: 'the summary\n', stderr: '' });

  it('returns the trimmed output', async () => {
    expect(await make(succeed).complete('p')).toBe('the summary');
  });

  it('runs one non-interactive completion with no tools', async () => {
    let args: string[] = [];
    await make(async (_binary: string, a: string[]) => {
      args = a;
      return { code: 0, stdout: 'x', stderr: '' };
    }).complete('summarise this');
    // --print, or it opens a session and never returns.
    expect(args).toContain('--print');
    // An empty allow-list, or the model can read files and run commands in
    // whatever directory ailoud happened to be started from.
    expect(args[args.indexOf('--allowed-tools') + 1]).toBe('');
  });

  it('sends the prompt on stdin, never as an argument', async () => {
    // A transcript of any length passes ARG_MAX -- about a megabyte on macOS,
    // less once the environment is counted -- and the spawn then fails with
    // E2BIG, which the user can do nothing about.
    let args: string[] = [];
    let options: { stdin?: string } = {};
    await make(async (_binary: string, a: string[], o: { stdin?: string }) => {
      args = a;
      options = o;
      return { code: 0, stdout: 'x', stderr: '' };
    }).complete('a very long transcript');
    expect(options.stdin).toBe('a very long transcript');
    expect(args).not.toContain('a very long transcript');
  });

  it('points at signing in when the CLI fails', async () => {
    const failing = async () => ({ code: 1, stdout: '', stderr: 'not authenticated' });
    await expect(make(failing).complete('p')).rejects.toThrow(FailureError);
    await expect(make(failing).complete('p')).rejects.toThrow(/not authenticated/);
    await expect(make(failing).complete('p')).rejects.toThrow(/signed in/);
  });

  it('treats empty output as a failure rather than an empty summary', async () => {
    // Exit 0 with nothing on stdout is what an unauthenticated CLI can do;
    // storing that as "the summary" would be silently wrong.
    const empty = async () => ({ code: 0, stdout: '   \n', stderr: '' });
    await expect(make(empty).complete('p')).rejects.toThrow(/returned nothing/);
  });
});
