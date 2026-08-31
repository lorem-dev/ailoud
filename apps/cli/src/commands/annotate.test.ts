import { describe, expect, it } from 'vitest';
import { UsageError } from '@laud/core';
import { buildProgram } from '../program.js';
import { context, contextWithTranscript } from './testContext.js';
import {
  MAX_SPEAKER_NAME_LENGTH,
  parseSpeakerAssignment,
  parseSpeakerAssignments,
} from './annotate.js';

describe('parseSpeakerAssignment', () => {
  it('splits a label from a name', () => {
    expect(parseSpeakerAssignment('speaker_00=Ann')).toEqual({
      label: 'speaker_00',
      name: 'Ann',
    });
  });

  it('splits on the first = only, so a name may contain one', () => {
    expect(parseSpeakerAssignment('spk0=Ann = the manager')).toEqual({
      label: 'spk0',
      name: 'Ann = the manager',
    });
  });

  it('trims, because shells and copy-paste add whitespace', () => {
    expect(parseSpeakerAssignment(' speaker_00 = Ann ')).toEqual({
      label: 'speaker_00',
      name: 'Ann',
    });
  });

  it('rejects a pair with no =', () => {
    expect(() => parseSpeakerAssignment('speaker_00')).toThrow(UsageError);
    expect(() => parseSpeakerAssignment('speaker_00')).toThrow(/expects "label=name"/);
  });

  it('rejects an empty label or an empty name', () => {
    // Neither identifies anyone, and storing one would produce a speaker that
    // cannot be referred to again.
    expect(() => parseSpeakerAssignment('=Ann')).toThrow(/empty label/);
    expect(() => parseSpeakerAssignment('speaker_00=')).toThrow(/empty name/);
    expect(() => parseSpeakerAssignment('speaker_00=   ')).toThrow(/empty name/);
  });
});

describe('parseSpeakerAssignments', () => {
  it('takes several', () => {
    expect(parseSpeakerAssignments(['a=Ann', 'b=Bob'])).toEqual([
      { label: 'a', name: 'Ann' },
      { label: 'b', name: 'Bob' },
    ]);
  });

  it('refuses the same label named twice', () => {
    // Last-one-wins would be a coin toss the user did not know they were
    // tossing.
    expect(() => parseSpeakerAssignments(['a=Ann', 'a=Bob'])).toThrow(/twice/);
  });

  it('allows two labels sharing a name, which is a real case', () => {
    // A diarizer splitting one person into two labels is common; naming both
    // the same person is how a user corrects it.
    expect(parseSpeakerAssignments(['a=Ann', 'b=Ann'])).toHaveLength(2);
  });
});

describe('laud annotate', () => {
  it('sets a title', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'laud', 'annotate', 'ID001', '--title', 'Standup']);
    expect((await ctx.store.getRecording('ID001'))?.title).toBe('Standup');
  });

  it('leaves the other field alone when only one is given', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync(['node', 'laud', 'annotate', 'ID001', '--notes', 'ctx']);
    await buildProgram(ctx).parseAsync(['node', 'laud', 'annotate', 'ID001', '--title', 'T']);
    const recording = await ctx.store.getRecording('ID001');
    expect(recording?.notes).toBe('ctx');
    expect(recording?.title).toBe('T');
  });

  it('stores speaker names against the recording', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync([
      'node',
      'laud',
      'annotate',
      'ID001',
      '--speaker',
      'speaker_00=Ann',
      '--speaker',
      'speaker_01=Bob',
    ]);
    expect(await ctx.store.listSpeakerNames('ID001')).toEqual([
      { label: 'speaker_00', name: 'Ann' },
      { label: 'speaker_01', name: 'Bob' },
    ]);
  });

  it('replaces a name rather than failing on a second attempt', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync([
      'node',
      'laud',
      'annotate',
      'ID001',
      '--speaker',
      'speaker_00=Ann',
    ]);
    await buildProgram(ctx).parseAsync([
      'node',
      'laud',
      'annotate',
      'ID001',
      '--speaker',
      'speaker_00=Anna',
    ]);
    // Naming the same speaker twice is a correction, not a conflict.
    expect(await ctx.store.listSpeakerNames('ID001')).toEqual([
      { label: 'speaker_00', name: 'Anna' },
    ]);
  });

  it('accepts a label no segment uses, since annotating before transcribing is reasonable', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    await buildProgram(ctx).parseAsync([
      'node',
      'laud',
      'annotate',
      'ID001',
      '--speaker',
      'speaker_42=Ann',
    ]);
    expect(await ctx.store.listSpeakerNames('ID001')).toHaveLength(1);
  });

  it('refuses to do nothing quietly', async () => {
    // A command that succeeds having changed nothing is indistinguishable
    // from one that worked.
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'import', '/in/a.mp3']);
    await expect(
      buildProgram(ctx).parseAsync(['node', 'laud', 'annotate', 'ID001']),
    ).rejects.toThrow(/needs something to set/);
  });

  it('takes an id prefix like every other command', async () => {
    const ctx = await contextWithTranscript();
    await buildProgram(ctx).parseAsync(['node', 'laud', 'annotate', 'ID0', '--title', 'T']);
    expect((await ctx.store.getRecording('ID001'))?.title).toBe('T');
  });
});

describe('the speaker name length limit', () => {
  it('accepts a realistic name', () => {
    // "Dr Anna Petrova-Smith" is 21 characters; the limit has to clear real
    // names comfortably or it is just an obstacle.
    expect(parseSpeakerAssignment('a=Dr Anna Petrova-Smith').name).toBe('Dr Anna Petrova-Smith');
  });

  it('accepts exactly the limit', () => {
    const name = 'x'.repeat(MAX_SPEAKER_NAME_LENGTH);
    expect(parseSpeakerAssignment(`a=${name}`).name).toBe(name);
  });

  it('refuses one character over, saying how long it was', () => {
    // A name prints in front of every line the person says, so a long one
    // pushes the transcript off the screen on every single line.
    const name = 'x'.repeat(MAX_SPEAKER_NAME_LENGTH + 1);
    expect(() => parseSpeakerAssignment(`a=${name}`)).toThrow(UsageError);
    expect(() => parseSpeakerAssignment(`a=${name}`)).toThrow(/33 characters/);
  });
});
