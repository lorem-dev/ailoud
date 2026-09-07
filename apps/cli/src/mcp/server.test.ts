import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { MemFs } from '@ailoud/core/testing';
import { context, contextWithTranscript, withRealDataDir } from '../commands/testContext.js';
import { buildProgram } from '../program.js';
import { createJob, getJob, listJobs } from '../jobs/store.js';
import { withJobLock } from '../jobs/lock.js';
import { spawnDetachedJob } from '../jobs/spawn.js';
import { writeJobState } from '../jobs/state.js';
import { buildMcpServer } from './server.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';

// Every transcribe/summarize call under test would otherwise spawn a real
// node process (see spawn.ts's own doc comment on why `cliEntryPath`
// resolves to a build that does not exist under a test runner). Mocked at
// the module boundary, the same way the CLI's own --detach tests mock it
// (apps/cli/src/commands/commands.test.ts, summarize.test.ts), so what is
// under test is this tool building the right job and the right argv, not a
// child process actually running.
vi.mock('../jobs/spawn.js', () => ({ spawnDetachedJob: vi.fn() }));

type Ctx = Awaited<ReturnType<typeof contextWithTranscript>>;

/**
 * Imports `path` -- writing its (fake) content into the in-memory fs first,
 * since nothing has put it there yet -- through the real `import` command,
 * so the resulting recording has a genuine mediaPath a later `transcribe`
 * call can actually read. Returns the new recording's id.
 */
async function importFixture(ctx: ReturnType<typeof context>, path: string): Promise<string> {
  (ctx.fs as MemFs).files.set(path, 'AUDIO');
  await buildProgram(ctx).parseAsync(['node', 'ailoud', 'import', path]);
  const recordings = await ctx.store.listRecordings({});
  return recordings[recordings.length - 1]!.id;
}

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

afterEach(() => {
  vi.mocked(spawnDetachedJob).mockReset();
});

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
        'job_status',
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
    expect(byName.get('job_status')?.annotations?.readOnlyHint).toBe(true);
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

describe('MCP: summarize starts a background job', () => {
  // The actual summarising -- template applied, context passed to the
  // model, the report saved -- now happens in the spawned child, which runs
  // the same `ailoud summarize` pipeline the CLI does (and is covered by
  // that command's own tests). What this tool owns, and what is under test
  // here, is building the right job and the right child argv from the
  // template and context it was given.
  it('passes the template and caller context through to the child argv', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      const { call, close } = await connect(ctx);
      const body = (
        await call('summarize', {
          recordingIds: ['ID001'],
          template: 'one-on-one',
          context: 'Ann is the manager.',
        })
      ).json();
      expect(body['jobId']).toBeDefined();
      expect(body['kind']).toBe('summarize');
      expect(body['summary']).toBeUndefined();
      expect(vi.mocked(spawnDetachedJob)).toHaveBeenCalledTimes(1);
      const [, commandArgs] = vi.mocked(spawnDetachedJob).mock.calls[0]!;
      expect(commandArgs).toEqual([
        'summarize',
        'ID001',
        '--template',
        'one-on-one',
        '--context',
        'Ann is the manager.',
      ]);
      await close();
    });
  });

  it('returns a job id rather than the summary body', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      const { call, close } = await connect(ctx);
      const body = (await call('summarize', { recordingIds: ['ID001'] })).json();
      expect(body['jobId']).toBeDefined();
      expect(body['summary']).toBeUndefined();
      expect(body['reportId']).toBeUndefined();
      await close();
    });
  });

  it('refuses synchronously when a job already holds the lock', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      await withJobLock(ctx.paths.dataDir, async () => {
        const { call, close } = await connect(ctx);
        const result = await call('summarize', { recordingIds: ['ID001'] });
        expect(result.isError).toBe(true);
        expect(result.json()['error']).toContain('already running');
        expect(spawnDetachedJob).not.toHaveBeenCalled();
        await close();
      });
    });
  });

  it('marks the job failed and reports it when spawning itself throws', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await withRealDataDir(ctx, async () => {
      vi.mocked(spawnDetachedJob).mockImplementation(() => {
        throw new Error('spawn boom');
      });
      const { call, close } = await connect(ctx);
      const result = await call('summarize', { recordingIds: ['ID001'] });
      expect(result.isError).toBe(true);
      const jobId = result.json()['jobId'] as string;
      const state = await getJob(ctx.fs, ctx.paths.jobsDir, jobId);
      expect(state?.state).toBe('failed');
      expect(state?.error).toContain('spawn boom');
      await close();
    });
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
  // Before this task, this tool called runSummary itself -- a second call
  // site the CLI's own copy could drift from (see the CLI's own
  // resolveSummarizeRun doc comment). Converting this tool to spawn the same
  // `ailoud summarize` the CLI runs removes the second call site entirely:
  // there is now exactly one place that reuses stored reports or refuses to
  // re-summarise a recording from its own report, and it is covered by that
  // command's own tests (apps/cli/src/commands/summarize.test.ts). What
  // remains to check here is that a group of ids reaches the child argv
  // untouched, in the order given.
  it('passes every id in a group through to the child, in order', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    const first = (await ctx.store.listRecordings({}))[0]!;
    await ctx.store.insertRecording({ ...first, id: 'ID002', sha256: 'other' });
    await withRealDataDir(ctx, async () => {
      const { call, close } = await connect(ctx);
      await call('summarize', { recordingIds: ['ID001', 'ID002'] });
      const [, commandArgs] = vi.mocked(spawnDetachedJob).mock.calls[0]!;
      expect(commandArgs).toEqual(['summarize', 'ID001', 'ID002']);
      await close();
    });
  });
});

describe('MCP: transcribe refuses until speakers and languages are declared', () => {
  it('refuses without a speaker count or languages, and offers a guess', async () => {
    const ctx = context();
    const id = await importFixture(ctx, '/in/2026-08-14-standup-ru-en.m4a');
    const { call, close } = await connect(ctx);
    const result = await call('transcribe', { recordingIds: [id] });
    expect(result.isError).toBe(true);
    const body = result.json();
    expect(body['error']).toContain('speaker count');
    const guess = body['guess'] as { languages: string[]; from: string };
    expect(guess.languages).toEqual(['ru', 'en']);
    expect(guess.from).toContain('2026-08-14-standup-ru-en.m4a');
    expect(body['ask']).toContain('Ask the user');
    await close();
  });

  it('refuses with a null guess when the name says nothing', async () => {
    const ctx = context();
    const id = await importFixture(ctx, '/in/rec0007.wav');
    const { call, close } = await connect(ctx);
    const result = await call('transcribe', { recordingIds: [id] });
    expect(result.isError).toBe(true);
    const body = result.json();
    // Null, never a fabrication: a guess invented from nothing gets confirmed
    // by a user who is skimming.
    expect(body['guess']).toBeNull();
    await close();
  });

  it('refuses when only one of the two is given', async () => {
    const ctx = context();
    const id = await importFixture(ctx, '/in/rec0007.wav');
    const { call, close } = await connect(ctx);
    for (const args of [{ speakers: 3 }, { languages: ['ru'] }]) {
      const result = await call('transcribe', { recordingIds: [id], ...args });
      expect(result.isError).toBe(true);
    }
    await close();
  });

  it('accepts the explicit not-knowns', async () => {
    const ctx = context();
    const id = await importFixture(ctx, '/in/rec0007.wav');
    await withRealDataDir(ctx, async () => {
      const { call, close } = await connect(ctx);
      const result = await call('transcribe', {
        recordingIds: [id],
        speakers: 'unknown',
        languages: ['auto'],
      });
      expect(result.isError).toBe(false);
      expect(result.json()['jobId']).toBeDefined();
      await close();
    });
  });

  // The diarizer itself no longer runs inside this call -- it runs in the
  // spawned child, which is mocked here (see the module-level vi.mock) and
  // covered by the CLI's own transcribe tests. What these two check is that
  // the child's argv reflects the same rule the inline pipeline used to
  // apply directly: --speakers only informs the diarizer, and only when a
  // real count was declared alongside --diarize.
  it('passes a declared speaker count to the child only when diarize is on', async () => {
    const ctx = context();
    const id = await importFixture(ctx, '/in/rec0007.wav');
    await withRealDataDir(ctx, async () => {
      const { call, close } = await connect(ctx);
      await call('transcribe', {
        recordingIds: [id],
        speakers: 3,
        languages: ['en'],
        diarize: true,
      });
      const [, commandArgs] = vi.mocked(spawnDetachedJob).mock.calls[0]!;
      expect(commandArgs).toContain('--diarize');
      expect(commandArgs).toEqual(expect.arrayContaining(['--speakers', '3']));
      await close();
    });
  });

  it('omits --speakers from the child argv when the count is unknown, even with diarize on', async () => {
    // Distinct from the sibling test above: this one holds diarize === true
    // fixed and varies only whether speakers is a number, so it actually
    // exercises the `typeof speakers === 'number'` half of the guard rather
    // than the `diarize === true` half.
    const ctx = context();
    const id = await importFixture(ctx, '/in/rec0007.wav');
    await withRealDataDir(ctx, async () => {
      const { call, close } = await connect(ctx);
      await call('transcribe', {
        recordingIds: [id],
        speakers: 'unknown',
        languages: ['en'],
        diarize: true,
      });
      const [, commandArgs] = vi.mocked(spawnDetachedJob).mock.calls[0]!;
      expect(commandArgs).toContain('--diarize');
      expect(commandArgs).not.toContain('--speakers');
      await close();
    });
  });

  it('refuses "auto" mixed with a real language', async () => {
    const ctx = context();
    const id = await importFixture(ctx, '/in/rec0007.wav');
    const { call, close } = await connect(ctx);
    const result = await call('transcribe', {
      recordingIds: [id],
      speakers: 'unknown',
      languages: ['auto', 'en'],
    });
    expect(result.isError).toBe(true);
    expect(result.raw).toContain('auto');
    await close();
  });

  it('refuses "auto" mixed with a real language regardless of order', async () => {
    const ctx = context();
    const id = await importFixture(ctx, '/in/rec0007.wav');
    const { call, close } = await connect(ctx);
    const result = await call('transcribe', {
      recordingIds: [id],
      speakers: 'unknown',
      languages: ['en', 'auto'],
    });
    expect(result.isError).toBe(true);
    expect(result.raw).toContain('auto');
    await close();
  });

  it('refuses a language entry that is not a two- or three-letter code', async () => {
    const ctx = context();
    const id = await importFixture(ctx, '/in/rec0007.wav');
    const { call, close } = await connect(ctx);
    const result = await call('transcribe', {
      recordingIds: [id],
      speakers: 'unknown',
      languages: ['english'],
    });
    expect(result.isError).toBe(true);
    await close();
  });

  it('refuses a language declared twice', async () => {
    const ctx = context();
    const id = await importFixture(ctx, '/in/rec0007.wav');
    const { call, close } = await connect(ctx);
    const result = await call('transcribe', {
      recordingIds: [id],
      speakers: 'unknown',
      languages: ['en', 'en'],
    });
    expect(result.isError).toBe(true);
    await close();
  });
});

describe('MCP: transcribe starts a background job', () => {
  it('returns a job id and does not block', async () => {
    const ctx = context();
    const id = await importFixture(ctx, '/in/rec0007.wav');
    await withRealDataDir(ctx, async () => {
      const { call, close } = await connect(ctx);
      const result = await call('transcribe', {
        recordingIds: [id],
        speakers: 2,
        languages: ['en'],
      });
      expect(result.isError).toBe(false);
      const body = result.json();
      expect(typeof body['jobId']).toBe('string');
      expect(body['jobId']).not.toBe('');
      expect(body['kind']).toBe('transcribe');
      expect(body['poll']).toContain('job_status');
      await close();
    });
  });

  it('refuses synchronously when a job already holds the lock', async () => {
    const ctx = context();
    const id = await importFixture(ctx, '/in/rec0007.wav');
    await withRealDataDir(ctx, async () => {
      await withJobLock(ctx.paths.dataDir, async () => {
        const { call, close } = await connect(ctx);
        const result = await call('transcribe', {
          recordingIds: [id],
          speakers: 2,
          languages: ['en'],
        });
        expect(result.isError).toBe(true);
        expect(result.json()['error']).toContain('already running');
        expect(spawnDetachedJob).not.toHaveBeenCalled();
        expect(await listJobs(ctx.fs, ctx.paths.jobsDir)).toEqual([]);
        await close();
      });
    });
  });

  it('marks the job failed and reports it when spawning itself throws', async () => {
    // The id handed out must always resolve: a job that never actually
    // started must not be left saying "running" forever.
    const ctx = context();
    const id = await importFixture(ctx, '/in/rec0007.wav');
    await withRealDataDir(ctx, async () => {
      vi.mocked(spawnDetachedJob).mockImplementation(() => {
        throw new Error('spawn boom');
      });
      const { call, close } = await connect(ctx);
      const result = await call('transcribe', {
        recordingIds: [id],
        speakers: 2,
        languages: ['en'],
      });
      expect(result.isError).toBe(true);
      const jobId = result.json()['jobId'] as string;
      const state = await getJob(ctx.fs, ctx.paths.jobsDir, jobId);
      expect(state?.state).toBe('failed');
      expect(state?.error).toContain('spawn boom');
      await close();
    });
  });
});

describe('MCP: job_status', () => {
  it('resolves an id the instant transcribe handed it out', async () => {
    const ctx = context();
    const id = await importFixture(ctx, '/in/rec0007.wav');
    await withRealDataDir(ctx, async () => {
      const { call, close } = await connect(ctx);
      const started = (
        await call('transcribe', { recordingIds: [id], speakers: 2, languages: ['en'] })
      ).json();
      const status = (await call('job_status', { jobId: started['jobId'] as string })).json();
      expect(status['id']).toBe(started['jobId']);
      expect(['running', 'failed', 'done']).toContain(status['state']);
      await close();
    });
  });

  it('reports an unknown job id as unknown, not as a failure', async () => {
    const ctx = context();
    const { call, close } = await connect(ctx);
    const result = await call('job_status', { jobId: '01K4NOSUCHJOBNOSUCHJOB00' });
    expect(result.isError).toBe(true);
    expect(result.json()['error']).toContain('no such job');
    await close();
  });

  it('never inlines the log, only its path', async () => {
    const ctx = context();
    const job = await createJob(
      { fs: ctx.fs, ids: ctx.ids, clock: ctx.clock, jobsDir: ctx.paths.jobsDir },
      { kind: 'transcribe', recordings: 1, declared: null },
    );
    // A stand-in for the ~104 lines of backend chatter one whisper run
    // writes to the log; the exact line is the one the design doc calls out
    // by name.
    await ctx.fs.writeTextFile(
      job.log,
      'whisper_print_progress_callback: progress = 42%\n'.repeat(20),
    );
    const { call, close } = await connect(ctx);
    const withId = await call('job_status', { jobId: job.id });
    expect(withId.json()['log']).toBe(job.log);
    expect(withId.raw).not.toContain('whisper_print_progress_callback');
    const listed = await call('job_status', {});
    expect(listed.raw).not.toContain('whisper_print_progress_callback');
    await close();
  });

  it('without an id, lists running jobs plus the five most recent finished ones', async () => {
    const ctx = context();
    for (let i = 0; i < 7; i += 1) {
      const job = await createJob(
        { fs: ctx.fs, ids: ctx.ids, clock: ctx.clock, jobsDir: ctx.paths.jobsDir },
        { kind: 'transcribe', recordings: 1, declared: null },
      );
      if (i < 2) continue; // leave the first two running
      await writeJobState(ctx.fs, ctx.paths.jobsDir, {
        ...job,
        state: 'done',
        finishedAt: ctx.clock.nowIso(),
      });
    }
    const { call, close } = await connect(ctx);
    const body = (await call('job_status', {})).json();
    const jobs = body['jobs'] as { state: string }[];
    expect(jobs.filter((job) => job.state === 'running')).toHaveLength(2);
    expect(jobs.filter((job) => job.state !== 'running')).toHaveLength(5);
    await close();
  });
});
