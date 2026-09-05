import { describe, expect, it } from 'vitest';
import { FailureError } from '@ailoud/core';
import type { PublishedVersion, VersionSource } from '@ailoud/core';
import { buildProgram, exitCodeFor } from '../program.js';
import { context } from './testContext.js';

/** A VersionSource that answers with a fixed list, never touching the network. */
function source(published: readonly PublishedVersion[]): VersionSource {
  return { published: async () => published };
}

describe('ailoud self check', () => {
  it('reports the target it would move to', async () => {
    const ctx = { ...context(), versionSource: source([{ version: '1.0.1', deprecated: false }]) };
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 'check']);
    expect(ctx.lines).toEqual(['ailoud 1.0.0 can update to 1.0.1.']);
  });

  it('says so when there is nothing newer', async () => {
    const ctx = { ...context(), versionSource: source([{ version: '1.0.0', deprecated: false }]) };
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 'check']);
    expect(ctx.lines).toEqual(['ailoud 1.0.0 is already the newest published version.']);
    // A version check is not a test: it must exit 0 either way.
  });

  it('prints JSON with --json', async () => {
    const ctx = { ...context(), versionSource: source([{ version: '1.0.1', deprecated: false }]) };
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 'check', '--json']);
    expect(JSON.parse(ctx.lines.join(''))).toEqual({
      current: '1.0.0',
      target: '1.0.1',
      updatable: true,
    });
  });

  it('prints JSON with no target when there is nothing newer', async () => {
    const ctx = { ...context(), versionSource: source([{ version: '1.0.0', deprecated: false }]) };
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 'check', '--json']);
    expect(JSON.parse(ctx.lines.join(''))).toEqual({
      current: '1.0.0',
      target: null,
      updatable: false,
    });
  });

  it('fails with the host and the timeout when the registry is unreachable', async () => {
    const ctx = {
      ...context(),
      updateRegistryHost: 'registry.npmjs.org',
      updateTimeoutMs: 10_000,
      versionSource: {
        published: async (): Promise<readonly PublishedVersion[]> => {
          throw new Error('fetch failed');
        },
      },
    };
    // Exit 1: an explicit check that could not run must not read as "up to date".
    await expect(buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 'check'])).rejects.toThrow(
      FailureError,
    );
    const error: unknown = await buildProgram(ctx)
      .parseAsync(['node', 'ailoud', 'self', 'check'])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FailureError);
    expect((error as Error).message).toContain('registry.npmjs.org');
    expect((error as Error).message).toContain('10000ms');
    expect(exitCodeFor(error)).toBe(1);
  });

  it('exists as a hidden top-level alias, "ailoud check"', async () => {
    const ctx = { ...context(), versionSource: source([{ version: '1.0.0', deprecated: false }]) };
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'check']);
    expect(ctx.lines).toEqual(['ailoud 1.0.0 is already the newest published version.']);
  });

  it('answers to its one-letter alias inside the group', async () => {
    const ctx = { ...context(), versionSource: source([{ version: '1.0.0', deprecated: false }]) };
    await buildProgram(ctx).parseAsync(['node', 'ailoud', 'self', 'c']);
    expect(ctx.lines).toEqual(['ailoud 1.0.0 is already the newest published version.']);
  });
});
