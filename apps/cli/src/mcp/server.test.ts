import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { MemFs } from '@ailoud/core/testing';
import { contextWithTranscript } from '../commands/testContext.js';
import { buildMcpServer } from './server.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';

type Ctx = Awaited<ReturnType<typeof contextWithTranscript>>;

/** A real client over an in-memory transport: the wiring is exercised, not mocked. */
async function connect(context: Ctx) {
  const { server, close } = buildMcpServer(context, '9.9.9');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return {
      isError: result.isError === true,
      raw: result.content[0]!.text,
      json: (): Record<string, unknown> => JSON.parse(result.content[0]!.text),
    };
  };
  return { client, call, close };
}

describe('the MCP surface', () => {
  it('offers a tool for every job an agent needs, and no more', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const { client, close } = await connect(ctx);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        'annotate',
        'create_template',
        'delete_recording',
        'delete_report',
        'get_report',
        'get_transcript',
        'import_recording',
        'list_recordings',
        'list_reports',
        'list_speakers',
        'list_tags',
        'list_templates',
        'list_untagged',
        'search_transcripts',
        'summarize',
        'transcribe',
      ].sort(),
    );
    await close();
  });

  it('describes every tool, since a nameless tool is an unusable one', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const { client, close } = await connect(ctx);
    for (const tool of (await client.listTools()).tools) {
      expect(tool.description ?? '', tool.name).not.toBe('');
      // Long enough to say when to use it and when not to, which is the part
      // that changes an agent's behaviour.
      expect((tool.description ?? '').length, tool.name).toBeGreaterThan(120);
    }
    await close();
  });

  it('describes every input field, so an agent need not guess a format', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const { client, close } = await connect(ctx);
    for (const tool of (await client.listTools()).tools) {
      const schema = tool.inputSchema as { properties?: Record<string, { description?: string }> };
      for (const [field, spec] of Object.entries(schema.properties ?? {})) {
        expect(spec.description ?? '', `${tool.name}.${field}`).not.toBe('');
      }
    }
    await close();
  });

  it('marks the read-only tools read-only and the destructive ones destructive', async () => {
    // A client that gates destructive tools can only do so if we say which.
    const ctx = await contextWithTranscript({ clearLines: true });
    const { client, close } = await connect(ctx);
    const byName = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
    expect(byName.get('search_transcripts')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('delete_recording')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('delete_report')?.annotations?.destructiveHint).toBe(true);
    await close();
  });

  it('tells the agent the rules before it calls anything', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const { client, close } = await connect(ctx);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
    // The four things that change behaviour most.
    expect(instructions).toMatch(/TAG EVERYTHING/);
    expect(instructions).toMatch(/SEARCH BEFORE READING/);
    expect(instructions).toMatch(/TRANSCRIPTS ARRIVE AS FILES/);
    expect(instructions).toMatch(/CARRY THE CONTEXT YOURSELF/);
    await close();
  });

  it('offers prompts for the routines that are easy to get wrong', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const { client, close } = await connect(ctx);
    const names = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
    expect(names).toEqual(
      expect.arrayContaining(['catch-up', 'tidy-library', 'summarise-properly']),
    );
    await close();
  });

  it('lists transcripts and reports as resources', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const { client, close } = await connect(ctx);
    const uris = (await client.listResources()).resources.map((resource) => resource.uri);
    expect(uris).toContain('ailoud://recording/ID001/transcript');
    await close();
  });
});

describe('MCP: reading without spending context', () => {
  it('search returns the matching lines, not the transcript', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const { call, close } = await connect(ctx);
    const result = await call('search_transcripts', { query: 'Privet' });
    const hits = result.json()['hits'] as { text: string; at: string }[];
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toContain('Privet');
    expect(hits[0]!.at).toMatch(/\d\d:\d\d/);
    await close();
  });

  it('get_transcript hands back a path and stats, never the text', async () => {
    // The rule the instructions state; here it is enforced.
    const ctx = await contextWithTranscript({ clearLines: true });
    const { call, close } = await connect(ctx);
    const result = await call('get_transcript', { recordingId: 'ID001' });
    const body = result.json();
    expect(typeof body['path']).toBe('string');
    expect(body['lines']).toBeGreaterThan(0);
    expect(result.raw).not.toContain('Privet');
    // And the file is really there, with the header the prompt relies on.
    const written = await ctx.fs.readTextFile(body['path'] as string);
    expect(written).toContain('Title:');
    expect(written).toContain('Privet');
    await close();
  });

  it('removes the scratch directory when the server stops', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const { call, close } = await connect(ctx);
    const path = (await call('get_transcript', { recordingId: 'ID001' })).json()['path'] as string;
    await close();
    await expect(ctx.fs.readTextFile(path)).rejects.toThrow();
  });

  it('flags untagged recordings, because untagged is unfindable by context', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const { call, close } = await connect(ctx);
    const listed = (await call('list_recordings')).json();
    expect(listed['untaggedCount']).toBe(1);
    const untagged = (await call('list_untagged')).json()['untagged'] as { id: string }[];
    expect(untagged.map((row) => row.id)).toEqual(['ID001']);

    await call('annotate', { recordingId: 'ID001', tags: ['standup'] });
    expect((await call('list_untagged')).json()['count']).toBe(0);
    await close();
  });
});

describe('MCP: refusals are marked as failures', () => {
  it('marks a refusal it decides on, not only a thrown error', async () => {
    // Returned as an ordinary success, an `error` field is something the agent
    // has to notice; a client's error handling never engages.
    const ctx = await contextWithTranscript({ clearLines: true });
    const { call, close } = await connect(ctx);
    expect((await call('summarize')).isError).toBe(true);
    expect((await call('summarize', { recordingIds: ['ID001'], template: 'nope' })).isError).toBe(
      true,
    );
    await close();
  });

  it('names the templates that do exist when one does not', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const { call, close } = await connect(ctx);
    const body = (await call('summarize', { recordingIds: ['ID001'], template: 'nope' })).json();
    expect(body['available']).toEqual(expect.arrayContaining(['one-on-one']));
    await close();
  });

  it('reports an ambiguous id with its candidates', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertRecording({
      ...(await ctx.store.listRecordings({}))[0]!,
      id: 'ID002',
      sha256: 'other',
    });
    const { call, close } = await connect(ctx);
    const result = await call('get_transcript', { recordingId: 'ID' });
    expect(result.isError).toBe(true);
    expect(result.raw).toContain('ID001');
    expect(result.raw).toContain('ID002');
    await close();
  });
});

describe('MCP: summarising', () => {
  it('uses the template and the caller context it was given, and saves the report', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const { call, close } = await connect(ctx);
    const body = (
      await call('summarize', {
        recordingIds: ['ID001'],
        template: 'one-on-one',
        context: 'Ann is the manager.',
      })
    ).json();
    expect(body['template']).toBe('one-on-one');
    expect(ctx.summarizerPrompts[0]).toContain('Concerns raised');
    expect(ctx.summarizerPrompts[0]).toContain('Ann is the manager.');
    const stored = await ctx.store.listSummaries('ID001');
    expect(stored[0]!.template).toBe('one-on-one');
    expect(stored[0]!.context).toBe('Ann is the manager.');
    await close();
  });
});

describe('MCP: deletion takes two calls, always', () => {
  it('deletes nothing on the first call and describes what would go', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const { call, close } = await connect(ctx);
    const first = (await call('delete_recording', { recordingIds: ['ID001'] })).json();
    expect(first['status']).toBe('confirmation required');
    expect(first['willDelete']).toBeDefined();
    expect(typeof first['confirmationToken']).toBe('string');
    expect(await ctx.store.getRecording('ID001')).not.toBeNull();
    await close();
  });

  it('says what survives, so the user is not told the wrong thing', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const { call, close } = await connect(ctx);
    const first = (await call('delete_recording', { recordingIds: ['ID001'] })).json();
    expect(String(first['notDeleted'])).toMatch(/original files/);
    expect(first['recoverable']).toBe(false);
    await close();
  });

  it('refuses a token nobody issued', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const { call, close } = await connect(ctx);
    const result = await call('delete_recording', {
      recordingIds: ['ID001'],
      confirmationToken: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.isError).toBe(true);
    expect(await ctx.store.getRecording('ID001')).not.toBeNull();
    await close();
  });

  it('refuses a token issued for a different kind of thing', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary({
      id: 'SUM1',
      createdAt: '2026-08-31T00:00:00.000Z',
      language: 'en',
      provider: 'fake',
      model: 'fake-model',
      body: 'x',
      template: 'meeting',
      context: '',
      recordingIds: ['ID001'],
    });
    const { call, close } = await connect(ctx);
    const token = (await call('delete_report', { reportIds: ['SUM1'] })).json()[
      'confirmationToken'
    ] as string;
    const result = await call('delete_recording', {
      recordingIds: ['ID001'],
      confirmationToken: token,
    });
    expect(result.isError).toBe(true);
    expect(await ctx.store.getRecording('ID001')).not.toBeNull();
    await close();
  });

  it('deletes on the second call with the right token, once', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const { call, close } = await connect(ctx);
    const token = (await call('delete_recording', { recordingIds: ['ID001'] })).json()[
      'confirmationToken'
    ] as string;
    const second = await call('delete_recording', {
      recordingIds: ['ID001'],
      confirmationToken: token,
    });
    expect(second.json()['status']).toBe('deleted');
    expect(await ctx.store.getRecording('ID001')).toBeNull();
    await close();
  });

  it('leaves recordings alone when a report is deleted', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await ctx.store.insertSummary({
      id: 'SUM1',
      createdAt: '2026-08-31T00:00:00.000Z',
      language: 'en',
      provider: 'fake',
      model: 'fake-model',
      body: 'x',
      template: 'meeting',
      context: '',
      recordingIds: ['ID001'],
    });
    const { call, close } = await connect(ctx);
    const token = (await call('delete_report', { reportIds: ['SUM1'] })).json()[
      'confirmationToken'
    ] as string;
    await call('delete_report', { reportIds: ['SUM1'], confirmationToken: token });
    expect(await ctx.store.listAllSummaries()).toEqual([]);
    expect(await ctx.store.getRecording('ID001')).not.toBeNull();
    expect(await ctx.store.latestTranscript('ID001')).not.toBeNull();
    await close();
  });
});

describe('MCP: the run directory and its file names', () => {
  it('keeps a hostile speaker name inside the run directory', async () => {
    // A speaker name is user-supplied and comes back in as a tool argument.
    // Interpolated raw, `speaker: "../../../../tmp/PWNED"` made this tool
    // write the transcript to /tmp/PWNED.txt -- an arbitrary file write
    // driven by a tool argument.
    const ctx = await contextWithTranscript({ clearLines: true });
    const { call, close } = await connect(ctx);
    const path = (
      await call('get_transcript', { recordingId: 'ID001', speaker: '../../../../tmp/PWNED' })
    ).json()['path'] as string;
    expect(path).not.toContain('/tmp/PWNED');
    expect(path.endsWith('.txt')).toBe(true);
    await close();
  });

  it('uses one directory for concurrent calls, and leaves none behind', async () => {
    // Memoising the resolved directory instead of the promise let two calls
    // in flight each create one, and the loser was left in /tmp with a
    // transcript in it after the server stopped.
    const ctx = await contextWithTranscript({ clearLines: true });
    const { call, close } = await connect(ctx);
    const [first, second] = await Promise.all([
      call('get_transcript', { recordingId: 'ID001' }),
      call('get_transcript', { recordingId: 'ID001', speaker: 'Ann' }),
    ]);
    const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/'));
    expect(dirOf(first.json()['path'] as string)).toBe(dirOf(second.json()['path'] as string));
    await close();
    const left = [...(ctx.fs as MemFs).files.keys()].filter((key) => key.includes('ID001.txt'));
    expect(left).toEqual([]);
  });
});

describe('MCP: one summarisation pipeline, shared with the CLI', () => {
  it('never re-summarises a single recording from its own stored report', async () => {
    // The rule that drifted while the pipeline was written twice: fixed in
    // the CLI command, and it had to be remembered separately here.
    const ctx = await contextWithTranscript({ clearLines: true });
    const { call, close } = await connect(ctx);
    await call('summarize', { recordingIds: ['ID001'] });
    ctx.summarizerPrompts.length = 0;
    await call('summarize', { recordingIds: ['ID001'], language: 'ru' });
    expect(ctx.summarizerPrompts[0]).toContain('Privet.');
    expect(ctx.summarizerPrompts[0]).not.toMatch(/earlier summary/i);
    await close();
  });

  it('reuses stored reports for a group, where they pay', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const first = (await ctx.store.listRecordings({}))[0]!;
    await ctx.store.insertRecording({ ...first, id: 'ID002', sha256: 'other' });
    for (const id of ['ID001', 'ID002']) {
      await ctx.store.insertSummary({
        id: `SUM-${id}`,
        createdAt: '2026-08-31T00:00:00.000Z',
        language: 'en',
        provider: 'fake',
        model: 'fake-model',
        body: `summary of ${id}`,
        template: 'meeting',
        context: '',
        recordingIds: [id],
      });
    }
    const { call, close } = await connect(ctx);
    const body = (await call('summarize', { recordingIds: ['ID001', 'ID002'] })).json();
    expect(body['reusedStoredReports']).toBe(2);
    await close();
  });
});
