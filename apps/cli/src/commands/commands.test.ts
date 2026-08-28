import { describe, expect, it } from 'vitest';
import { FailureError } from '@laud/core';
import { buildProgram } from '../program.js';
import { context } from './testContext.js';

describe('laud import', () => {
  it('prints the id of an imported recording', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    expect(ctx.lines).toEqual(['ID001  imported  /in/a.mp3']);
  });

  it('says so when the file is already in the library', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    expect(ctx.lines[1]).toBe('ID001  already present  /in/a.mp3');
  });
});

describe('laud transcribe', () => {
  it('transcribes every recording without a transcript by default', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe']);
    expect(ctx.lines[1]).toBe('ID001  ru  1 segment');
  });

  it('reports that there is nothing to do', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe']);
    expect(ctx.lines).toEqual(['Nothing to transcribe.']);
  });

  it('refuses --force without a selector', async () => {
    const ctx = context();
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe', '--force']),
    ).rejects.toThrow(/--force/);
  });

  it('skips a recording that already has a transcript by default', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe']);
    await buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe', 'ID001']);
    expect(ctx.lines[2]).toBe('ID001  already transcribed (use --force)');
  });

  it('--force re-transcribes a recording that already has a transcript', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe']);
    await buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe', 'ID001', '--force']);
    expect(ctx.lines[2]).toBe('ID001  ru  1 segment');
  });

  it('passes --model through to the transcription provider', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync([
      'node',
      'laud',
      'transcribe',
      '--model',
      '/models/big.bin',
    ]);
    expect(ctx.sttInstances).toHaveLength(1);
    expect(ctx.sttInstances[0]!.calls[0]).toEqual(
      expect.objectContaining({ model: '/models/big.bin' }),
    );
  });

  it('passes --stt-lang through as the language hint', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe', '--stt-lang', 'ru']);
    expect(ctx.lines[1]).toBe('ID001  ru  1 segment');
  });

  it('--multilingual reaches the pipeline instead of the single-pass path', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    // The default fake provider does not support language detection, so
    // the multilingual pipeline (packages/core/src/pipelines/transcribe.ts)
    // refuses with its own, distinct error as soon as it checks
    // capabilities -- proof that --multilingual reached transcribeRecording
    // and took the multilingual branch, not the single-pass one.
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe', '--multilingual']),
    ).rejects.toThrow(/cannot detect a language/);
  });

  it('without --multilingual, transcribe takes the single-pass path', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe']);
    expect(ctx.segmenterInstances).toHaveLength(0);
    expect(ctx.lines[1]).toBe('ID001  ru  1 segment');
  });

  it('fails on a mix of known and unknown ids without transcribing the known one', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe', 'ID001', 'ID999']),
    ).rejects.toThrow(FailureError);
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe', 'ID001', 'ID999']),
    ).rejects.toThrow(/ID999/);
    // Only the import line: transcription never ran for ID001 either.
    expect(ctx.lines).toEqual(['ID001  imported  /in/a.mp3']);
  });

  it('fails when every requested id is unknown, transcribing nothing', async () => {
    const ctx = context();
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe', 'ID999']),
    ).rejects.toThrow(FailureError);
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'transcribe', 'ID999']),
    ).rejects.toThrow(/ID999/);
    expect(ctx.lines).toEqual([]);
  });
});
