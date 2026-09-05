import { describe, expect, it } from 'vitest';
import { FailureError, UsageError } from '@ailoud/core';
import { buildProgram } from '../program.js';
import { contextWithTranscript } from './testContext.js';

const dirOf = (ctx: { paths: { configFile: string } }) =>
  ctx.paths.configFile.replace(/\/[^/]*$/, '/templates');

describe('ailoud template ls', () => {
  it('writes the built-ins out on first use, so they can be read and edited', async () => {
    const ctx = await contextWithTranscript({ skipImport: true, clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'template', 'ls']);
    const out = ctx.lines.join('\n');
    for (const name of [
      'one-on-one',
      'performance-review',
      'architecture-planning',
      'solution-decision',
    ]) {
      expect(out, name).toContain(name);
    }
    expect(await ctx.fs.exists(`${dirOf(ctx)}/one-on-one.yaml`)).toBe(true);
  });

  it('says where to edit them, since that is the point of writing them out', async () => {
    const ctx = await contextWithTranscript({ skipImport: true, clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'template', 'ls']);
    expect(ctx.lines.join('\n')).toContain(dirOf(ctx));
  });

  it('works through the letter alias', async () => {
    const ctx = await contextWithTranscript({ skipImport: true, clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'template', 'l']);
    expect(ctx.lines.join('\n')).toContain('one-on-one');
  });
});

describe('ailoud template show', () => {
  it('prints the file path and the template as stored', async () => {
    const ctx = await contextWithTranscript({ skipImport: true, clearLines: true });
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'template', 'show', 'solution-decision']);
    const out = ctx.lines.join('\n');
    expect(out).toContain('solution-decision.yaml');
    expect(out).toContain('Rejected alternatives');
  });

  it('says so when there is no such template', async () => {
    const ctx = await contextWithTranscript({ skipImport: true, clearLines: true });
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'template', 'show', 'nope']),
    ).rejects.toThrow(FailureError);
  });
});

describe('ailoud template new', () => {
  const run = (ctx: Awaited<ReturnType<typeof contextWithTranscript>>, args: string[]) =>
    buildProgram(ctx).parseAsync(['node', 'ailoud', 'template', 'new', ...args]);

  it('creates a template that summarize can then use', async () => {
    const ctx = await contextWithTranscript({ clearLines: true });
    await run(ctx, [
      'retro',
      '--context',
      'A sprint retro.',
      '--heading',
      'Went well',
      '--heading',
      'Actions',
    ]);
    ctx.summarizerPrompts.length = 0;
    await buildProgram(ctx).parseAsync([
      'node',
      'ailoud',
      'summarize',
      'ID001',
      '--template',
      'retro',
    ]);
    expect(ctx.summarizerPrompts[0]).toContain('Went well');
    expect(ctx.summarizerPrompts[0]).toContain('A sprint retro.');
  });

  it('can start from an existing template', async () => {
    const ctx = await contextWithTranscript({ skipImport: true, clearLines: true });
    await run(ctx, ['skip-level', '--from', 'one-on-one', '--summary', 'skip level']);
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'template', 'show', 'skip-level']);
    // Inherited both the headings and the context sentence.
    expect(ctx.lines.join('\n')).toContain('Concerns raised');
    expect(ctx.lines.join('\n')).toMatch(/one-to-one/i);
  });

  it('refuses to overwrite prose somebody already wrote', async () => {
    const ctx = await contextWithTranscript({ skipImport: true, clearLines: true });
    await expect(
      run(ctx, ['one-on-one', '--context', 'Mine.', '--heading', 'A', '--heading', 'B']),
    ).rejects.toThrow(/already exists/);
  });

  it('insists on a context sentence and two headings', async () => {
    const ctx = await contextWithTranscript({ skipImport: true, clearLines: true });
    await expect(run(ctx, ['thin', '--heading', 'A', '--heading', 'B'])).rejects.toThrow(
      /needs --context/,
    );
    await expect(run(ctx, ['thin', '--context', 'A chat.', '--heading', 'A'])).rejects.toThrow(
      /at least two --heading/,
    );
  });

  it('refuses a name that is not a usable file name', async () => {
    const ctx = await contextWithTranscript({ skipImport: true, clearLines: true });
    await expect(
      run(ctx, ['../escape', '--context', 'x', '--heading', 'A', '--heading', 'B']),
    ).rejects.toThrow(UsageError);
  });

  it('keeps the headings in the order they were given', async () => {
    const ctx = await contextWithTranscript({ skipImport: true, clearLines: true });
    await run(ctx, ['ordered', '--context', 'x', '--heading', 'First', '--heading', 'Second']);
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'template', 'show', 'ordered']);
    const out = ctx.lines.join('\n');
    expect(out.indexOf('First')).toBeLessThan(out.indexOf('Second'));
  });

  it('says how to use what it just made', async () => {
    const ctx = await contextWithTranscript({ skipImport: true, clearLines: true });
    await run(ctx, ['x-shape', '--context', 'x', '--heading', 'A', '--heading', 'B']);
    expect(ctx.lines.join('\n')).toContain('--template x-shape');
  });
});
