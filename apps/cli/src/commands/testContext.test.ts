import { describe, expect, it } from 'vitest';
import { context, contextWithTranscript } from './testContext.js';

describe('context', () => {
  it('starts with an empty library and no captured output', async () => {
    const ctx = context();
    expect(ctx.lines).toEqual([]);
    expect(await ctx.store.listRecordings({})).toEqual([]);
  });
});

describe('contextWithTranscript', () => {
  it('imports and transcribes the fixture recording by default', async () => {
    const ctx = await contextWithTranscript();
    const recordings = await ctx.store.listRecordings({});
    expect(recordings).toHaveLength(1);
    expect(await ctx.store.latestTranscript(recordings[0]!.id)).not.toBeNull();
  });

  it('skipImport leaves the library empty', async () => {
    const ctx = await contextWithTranscript({ skipImport: true });
    expect(await ctx.store.listRecordings({})).toEqual([]);
    expect(ctx.lines).toEqual([]);
  });

  it('skipTranscribe leaves the recording without a transcript', async () => {
    const ctx = await contextWithTranscript({ skipTranscribe: true });
    const recordings = await ctx.store.listRecordings({});
    expect(recordings).toHaveLength(1);
    expect(await ctx.store.latestTranscript(recordings[0]!.id)).toBeNull();
  });
});
