import { describe, expect, it } from 'vitest';
import { buildProgram } from '../program.js';
import { context } from './testContext.js';
import { writeJobState } from '../jobs/state.js';
import type { JobState } from '../jobs/state.js';

function job(partial: Partial<JobState> = {}): JobState {
  return {
    id: 'JOB00000000000000000000001',
    kind: 'transcribe',
    state: 'done',
    percent: 100,
    stage: 'done',
    pid: process.pid,
    startedAt: '2026-09-07T08:00:00.000Z',
    finishedAt: '2026-09-07T08:05:00.000Z',
    recordings: { total: 1, done: 1 },
    declared: null,
    log: '/d/jobs/JOB00000000000000000000001.log',
    result: null,
    error: null,
    ...partial,
  };
}

describe('ailoud job ls', () => {
  it('says so plainly when there are no jobs', async () => {
    const ctx = context();
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'job', 'ls']),
    ).resolves.toBeDefined();
    expect(ctx.lines.join('\n')).toMatch(/No background jobs yet/);
  });

  it('emits an empty array for --json rather than an error', async () => {
    const ctx = context();
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'job', 'ls', '--json']);
    expect(ctx.lines.join('')).toContain('[]');
  });

  it('lists jobs newest first, with state and percentage', async () => {
    const ctx = context();
    await writeJobState(
      ctx.fs,
      ctx.paths.jobsDir,
      job({ id: 'JOB00000000000000000000001', state: 'running', percent: 40 }),
    );
    await writeJobState(
      ctx.fs,
      ctx.paths.jobsDir,
      job({ id: 'JOB00000000000000000000002', state: 'done', percent: 100 }),
    );
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'job', 'ls']);
    const out = ctx.lines.join('\n');
    expect(out).toContain('running');
    expect(out).toContain('40%');
    expect(out.indexOf('JOB00000000000000000000002')).toBeLessThan(
      out.indexOf('JOB00000000000000000000001'),
    );
  });

  it('dispatches on the one-letter alias', async () => {
    const ctx = context();
    await writeJobState(ctx.fs, ctx.paths.jobsDir, job());
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'job', 'l']);
    expect(ctx.lines.join('\n')).toContain(job().id);
  });
});

describe('ailoud job show', () => {
  it('shows one job as json, including the log path', async () => {
    const ctx = context();
    await writeJobState(ctx.fs, ctx.paths.jobsDir, job());
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'job', 'show', job().id, '--json']);
    const parsed = JSON.parse(ctx.lines.join('')) as JobState;
    expect(parsed.id).toBe(job().id);
    expect(parsed.log).toBe(job().log);
  });

  it('shows one job as text, including its log path', async () => {
    const ctx = context();
    await writeJobState(ctx.fs, ctx.paths.jobsDir, job());
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'job', 'show', job().id]);
    const out = ctx.lines.join('\n');
    expect(out).toContain(job().id);
    expect(out).toContain(job().log);
  });

  it('reports an unknown id as unknown, distinctly from a failure', async () => {
    const ctx = context();
    await writeJobState(ctx.fs, ctx.paths.jobsDir, job({ id: 'JOB00000000000000000000009' }));
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'job', 'show', 'NOSUCHJOB']),
    ).rejects.toThrow(/UNKNOWN/);
    // A job that genuinely failed must not read the same way.
    await writeJobState(
      ctx.fs,
      ctx.paths.jobsDir,
      job({ id: 'JOB00000000000000000000003', state: 'failed', error: 'ffmpeg crashed' }),
    );
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync([
      'node',
      'ailoud',
      'job',
      'show',
      'JOB00000000000000000000003',
    ]);
    expect(ctx.lines.join('\n')).not.toMatch(/UNKNOWN/);
  });
});

describe('ailoud job rm', () => {
  it('removes a finished job and its log', async () => {
    const ctx = context();
    await writeJobState(ctx.fs, ctx.paths.jobsDir, job());
    await ctx.fs.writeTextFile(job().log, 'log contents');
    ctx.lines.length = 0;
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'job', 'rm', job().id]);
    expect(ctx.lines.join('\n')).toContain('removed');
    await expect(ctx.fs.exists(`${ctx.paths.jobsDir}/${job().id}.json`)).resolves.toBe(false);
    await expect(ctx.fs.exists(job().log)).resolves.toBe(false);
  });

  it('refuses to remove a running job', async () => {
    const ctx = context();
    // A live pid, so withLiveness (applied by getJob) does not correct this
    // to `failed` before rm ever sees it: this process itself is running.
    await writeJobState(ctx.fs, ctx.paths.jobsDir, job({ state: 'running', pid: process.pid }));
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'job', 'rm', job().id]),
    ).rejects.toThrow(/does not stop it|cannot stop a running job/);
    await expect(ctx.fs.exists(`${ctx.paths.jobsDir}/${job().id}.json`)).resolves.toBe(true);
  });

  it('reports an unknown id as unknown rather than removing nothing silently', async () => {
    const ctx = context();
    await expect(
      buildProgram(ctx).parseAsync(['node', 'ailoud', 'job', 'rm', 'NOSUCHJOB']),
    ).rejects.toThrow(/UNKNOWN/);
  });
});
