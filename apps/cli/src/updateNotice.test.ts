import { describe, expect, it } from 'vitest';
import type { PublishedVersion } from '@ailoud/core';
import { MemFs, FakeClock } from '@ailoud/core/testing';
import { startUpdateCheck, updateCachePath } from './updateNotice.js';
import type { NoticeDeps } from './updateNotice.js';

const DATA_DIR = '/data/ailoud';

/** Lets every pending microtask run, so an "already settled" fake fetch or
 * cache read has actually resolved before a test calls `finish()`. Real
 * usage never needs this: the command being run does real work between
 * `startUpdateCheck` and `finish()`, which is what this stands in for. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A `published` that resolves with a fixed list, never touching a network. */
function published(versions: readonly PublishedVersion[]): NoticeDeps['published'] {
  return () => Promise.resolve(versions);
}

/** A `published` that never settles -- the shape a hung connection has from
 * this module's point of view, whether or not it is ever aborted. */
function hangingPublished(): NoticeDeps['published'] {
  return () => new Promise(() => undefined);
}

function baseDeps(overrides: Partial<NoticeDeps> = {}): NoticeDeps {
  return {
    fs: new MemFs(),
    clock: new FakeClock(),
    userDataDir: DATA_DIR,
    currentVersion: '1.0.0',
    argv: ['ls'],
    env: {},
    stderrIsTTY: true,
    checkEnabled: true,
    published: published([{ version: '1.1.0', deprecated: false }]),
    ...overrides,
  };
}

describe('startUpdateCheck', () => {
  it('prints nothing and waits for nothing when the fetch has not settled', async () => {
    // The whole point. Awaiting the network before exit would add up to two
    // seconds to `ailoud ls`.
    const notice = startUpdateCheck(baseDeps({ published: hangingPublished() }));
    expect(await notice.finish()).toBeNull();
  });

  it('prints from the cache when this run could not refresh it', async () => {
    const fs = new MemFs({
      [updateCachePath(DATA_DIR)]: JSON.stringify({
        checkedAt: '2026-01-01T00:00:00.000Z',
        target: '1.2.3',
      }),
    });
    // A fetch that would hang forever if it were ever started: a fresh cache
    // must answer without going anywhere near the network.
    const deps = baseDeps({ fs, published: hangingPublished() });

    const notice = startUpdateCheck(deps);
    await flush();

    expect(await notice.finish()).toBe('1.2.3');
  });

  it('caches a failure too, so a broken network costs one attempt a day', async () => {
    const fs = new MemFs();
    const deps = baseDeps({
      fs,
      published: () => Promise.reject(new Error('registry unreachable')),
    });

    const notice = startUpdateCheck(deps);
    await flush();

    expect(await notice.finish()).toBeNull();
    const raw = fs.files.get(updateCachePath(DATA_DIR));
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toMatchObject({ target: null });
  });

  it('is silent when stderr is not a TTY', async () => {
    let called = false;
    const deps = baseDeps({
      stderrIsTTY: false,
      published: () => {
        called = true;
        return Promise.resolve([{ version: '1.1.0', deprecated: false }]);
      },
    });

    const notice = startUpdateCheck(deps);
    await flush();

    expect(await notice.finish()).toBeNull();
    expect(called).toBe(false);
  });

  it('is silent with --json', async () => {
    let called = false;
    const deps = baseDeps({
      argv: ['ls', '--json'],
      published: () => {
        called = true;
        return Promise.resolve([{ version: '1.1.0', deprecated: false }]);
      },
    });

    const notice = startUpdateCheck(deps);
    await flush();

    expect(await notice.finish()).toBeNull();
    expect(called).toBe(false);
  });

  it('is silent in the MCP server', async () => {
    let called = false;
    const deps = baseDeps({
      argv: ['mcp'],
      published: () => {
        called = true;
        return Promise.resolve([{ version: '1.1.0', deprecated: false }]);
      },
    });

    const notice = startUpdateCheck(deps);
    await flush();

    expect(await notice.finish()).toBeNull();
    expect(called).toBe(false);
  });

  it('is silent when AILOUD_NO_UPDATE_CHECK is set', async () => {
    let called = false;
    const deps = baseDeps({
      env: { AILOUD_NO_UPDATE_CHECK: '1' },
      published: () => {
        called = true;
        return Promise.resolve([{ version: '1.1.0', deprecated: false }]);
      },
    });

    const notice = startUpdateCheck(deps);
    await flush();

    expect(await notice.finish()).toBeNull();
    expect(called).toBe(false);
  });

  it('is silent when config update.check is false', async () => {
    let called = false;
    const deps = baseDeps({
      checkEnabled: false,
      published: () => {
        called = true;
        return Promise.resolve([{ version: '1.1.0', deprecated: false }]);
      },
    });

    const notice = startUpdateCheck(deps);
    await flush();

    expect(await notice.finish()).toBeNull();
    expect(called).toBe(false);
  });

  it('is silent for self check and self update themselves', async () => {
    const argvs = [
      ['self', 'check'],
      ['self', 'c'],
      ['self', 'update'],
      ['self', 'u'],
      ['check'],
      ['update'],
    ];
    for (const argv of argvs) {
      let called = false;
      const deps = baseDeps({
        argv,
        published: () => {
          called = true;
          return Promise.resolve([{ version: '1.1.0', deprecated: false }]);
        },
      });

      const notice = startUpdateCheck(deps);
      await flush();

      expect(await notice.finish()).toBeNull();
      expect(called).toBe(false);
    }
  });
});
