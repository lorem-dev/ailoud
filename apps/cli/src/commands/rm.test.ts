import { describe, expect, it, vi } from 'vitest';
import { UsageError } from '@laud/core';
import { buildProgram } from '../program.js';
import { context } from './testContext.js';
import { describeDeletion } from './rm.js';

vi.mock('@clack/prompts', async () => {
  const actual = await vi.importActual<typeof import('@clack/prompts')>('@clack/prompts');
  return { ...actual, confirm: vi.fn(async () => true), isCancel: () => false };
});

async function withOneRecording() {
  const ctx = context();
  await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
  ctx.lines.length = 0;
  return ctx;
}

describe('describeDeletion', () => {
  it('says the source file is not touched', () => {
    // The single most confusable thing about this command: import COPIES,
    // so deleting a recording removes laud's copy and leaves the original.
    const lines = describeDeletion([
      { id: 'ID001', sourcePath: '/in/a.mp3', title: null } as never,
    ]);
    expect(lines.join('\n')).toMatch(/not touched/);
  });

  it('counts in the singular for one and the plural for several', () => {
    const one = describeDeletion([{ id: 'A', sourcePath: '/a', title: null } as never]);
    expect(one[0]).toMatch(/1 recording,/);
    const two = describeDeletion([
      { id: 'A', sourcePath: '/a', title: null } as never,
      { id: 'B', sourcePath: '/b', title: null } as never,
    ]);
    expect(two[0]).toMatch(/2 recordings,/);
  });

  it('prefers a title over the source path when there is one', () => {
    const lines = describeDeletion([
      { id: 'A', sourcePath: '/in/long/path.mp3', title: 'Standup' } as never,
    ]);
    expect(lines.join('\n')).toContain('Standup');
  });
});

describe('laud rm', () => {
  it('deletes the recording and laud copy of its audio', async () => {
    const ctx = await withOneRecording();
    const mediaFiles = () => [...ctx.fs.files.keys()].filter((p) => p.includes('/media/'));
    expect(mediaFiles()).toHaveLength(1);

    await buildProgram(ctx).parseAsync(['node', 'laud', 'rm', 'ID001', '--force']);

    expect(await ctx.store.getRecording('ID001')).toBeNull();
    expect(mediaFiles()).toHaveLength(0);
  });

  it('leaves the imported source file alone', async () => {
    const ctx = await withOneRecording();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'rm', 'ID001', '--force']);
    // The whole point of the wording in describeDeletion.
    expect(ctx.fs.files.has('/in/a.mp3')).toBe(true);
  });

  it('deletes nothing at all when any id is unknown', async () => {
    const ctx = await withOneRecording();
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'rm', 'ID001', 'NOPE', '--force']),
    ).rejects.toThrow(/NOPE/);
    // A typo in the second of two ids must not leave the first one gone:
    // there is no undo here.
    expect(await ctx.store.getRecording('ID001')).not.toBeNull();
  });

  it('says so, rather than failing, when the audio was already gone', async () => {
    const ctx = await withOneRecording();
    for (const path of [...ctx.fs.files.keys()]) {
      if (path.includes('/media/')) ctx.fs.files.delete(path);
    }
    await buildProgram(ctx).parseAsync(['node', 'laud', 'rm', 'ID001', '--force']);
    expect(ctx.lines.join('\n')).toMatch(/already gone/);
    expect(await ctx.store.getRecording('ID001')).toBeNull();
  });

  it('takes the transcripts with it', async () => {
    const ctx = await withOneRecording();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe', 'ID001']);
    expect(await ctx.store.latestTranscript('ID001')).not.toBeNull();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'rm', 'ID001', '--force']);
    expect(await ctx.store.latestTranscript('ID001')).toBeNull();
  });

  it('refuses without --force when there is no terminal to ask on', async () => {
    // The worst outcome this file could have is a script that silently
    // deletes a library, so the no-terminal path must refuse rather than
    // assume consent. vitest gives the process no tty, which is the case.
    const ctx = await withOneRecording();
    await expect(buildProgram(ctx).parseAsync(['node', 'laud', 'rm', 'ID001'])).rejects.toThrow(
      UsageError,
    );
    expect(await ctx.store.getRecording('ID001')).not.toBeNull();
  });
});

describe('the shared consent guard, as rm uses it', () => {
  it('names deleting and --force, not installing software and --yes', async () => {
    // The guard is shared with setup on purpose -- one answer to "may this
    // run change things unasked" -- but its wording is not shared, and the
    // first version of rm inherited setup's, telling a user about to delete
    // recordings that laud "needs confirmation before installing software".
    const ctx = await withOneRecording();
    const error: unknown = await buildProgram(ctx)
      .parseAsync(['node', 'laud', 'rm', 'ID001'])
      .catch((caught: unknown) => caught);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/deleting recordings/);
    expect(message).toMatch(/--force/);
    expect(message).not.toMatch(/installing software/);
    expect(message).not.toMatch(/--yes/);
  });
});
