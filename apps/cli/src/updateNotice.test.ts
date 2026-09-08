import { describe, expect, it, vi } from 'vitest';
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

/** A `published` that behaves like the real `registryPublished`: it never
 * settles on its own within a test's lifetime, but REJECTS the instant its
 * signal is aborted -- exactly what `https.request`'s own `signal` option
 * does. `hangingPublished` above does not model this at all (it ignores the
 * signal entirely), which is exactly why the review found the abort-poisons
 * -the-cache defect survived every existing test: none of them exercised a
 * fetch that actually reacts to being aborted. */
function abortablePublished(): NoticeDeps['published'] {
  return (signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
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
    // must answer without going anywhere near the network. No `await
    // flush()` here: real usage never performs one between
    // `startUpdateCheck()` and `finish()`, and a test that needs one to pass
    // is proving nothing about production -- see `finish()`'s own bounded
    // wait, which is what actually gives this cache read a chance to win.
    const deps = baseDeps({ fs, published: hangingPublished() });

    const notice = startUpdateCheck(deps);

    expect(await notice.finish()).toBe('1.2.3');
  });

  it('bounds a slow disk read instead of waiting for it', async () => {
    // Stands in for a slow or momentarily unresponsive filesystem (a
    // network home directory, a sleeping external drive, a contended or
    // nearly full disk): the read resolves, but only long after any
    // budget this module may spend waiting for it. Real usage has no
    // signal to cancel this with -- `Fs` offers none -- so the only
    // available fix is bounding how long anything here waits for it,
    // never assuming the disk itself can be made to stop. Unref'd so this
    // fixture alone cannot hold the test process open: the property under
    // test is whether the SOURCE gives up on it, not whether this fake
    // does.
    const fs = new MemFs();
    fs.exists = (): Promise<boolean> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 3000);
        timer.unref();
      });
    let called = false;
    const deps = baseDeps({
      fs,
      published: () => {
        called = true;
        return Promise.resolve([{ version: '1.1.0', deprecated: false }]);
      },
    });

    const notice = startUpdateCheck(deps);
    await notice.finish();
    // Well past this module's own ~50ms budget, but nowhere near the
    // disk's 3 second delay: if the disk read were still being awaited,
    // the registry would not have been reached yet, because `readCache`
    // runs before it on every path.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(called).toBe(true);
  }, 2500);

  it('unrefs the bounded wait timer, so it alone cannot keep the process alive', async () => {
    const createdTimers: NodeJS.Timeout[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout');
    spy.mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const timer = realSetTimeout(...args);
      createdTimers.push(timer);
      return timer;
    }) as typeof setTimeout);

    try {
      // A fetch that never settles, so `finish()` can only ever be answered
      // by the bounded wait's own timer -- exactly the timer under test.
      const notice = startUpdateCheck(baseDeps({ published: hangingPublished() }));
      expect(await notice.finish()).toBeNull();
    } finally {
      spy.mockRestore();
    }

    expect(createdTimers.length).toBeGreaterThan(0);
    for (const timer of createdTimers) {
      // hasRef() is Node's own answer to "does this timer count against the
      // event loop staying open": false is what lets a command whose own
      // work is already done exit immediately, unheld by this wait.
      expect(timer.hasRef()).toBe(false);
    }
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

  it('never caches a null caused by its own abort, so the next run retries', async () => {
    // The defect found in review: BOUND_MS covers the whole check, so a
    // fast command's fetch is always still in flight when finish() gives
    // up and aborts it. `abortablePublished` rejects on that abort exactly
    // as the real HTTPS client does -- if the catch block cached that
    // rejection as a genuine "no update", the notice could never fire.
    const fs = new MemFs();
    const deps = baseDeps({ fs, published: abortablePublished() });

    const notice = startUpdateCheck(deps);
    expect(await notice.finish()).toBeNull();
    // Give the abort's rejection a chance to reach the catch block; a real
    // command's own work would take far longer than this in practice.
    await flush();

    expect(fs.files.has(updateCachePath(DATA_DIR))).toBe(false);
  }, 2000);

  it('fills the cache with a genuine answer once the fetch actually settles', async () => {
    // The consequence documented on startUpdateCheck: a command slow enough
    // to outlast the round trip is the one that fills the cache. Simulated
    // here by letting the fetch resolve (via flush()) before finish() is
    // even called, the way a real multi-second command would without a
    // test needing to wait multiple seconds.
    const fs = new MemFs();
    const deps = baseDeps({
      fs,
      published: published([{ version: '1.2.3', deprecated: false }]),
    });

    const notice = startUpdateCheck(deps);
    await flush();

    expect(await notice.finish()).toBe('1.2.3');
    const raw = fs.files.get(updateCachePath(DATA_DIR));
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toMatchObject({ target: '1.2.3' });
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

  it('is silent with --format json', async () => {
    // `show <id> --format json` is machine-readable output too, and with
    // stdout and stderr merged this notice would land inside it just like
    // `--json` would.
    let called = false;
    const deps = baseDeps({
      argv: ['show', 'abc123', '--format', 'json'],
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

describe('the MCP suppression must not catch a run that only prints help', () => {
  it('stays silent for the bare mcp server', async () => {
    const notice = startUpdateCheck(baseDeps({ argv: ['mcp'] }));
    expect(await notice.finish()).toBeNull();
  });

  it.each([['--help'], ['-h'], ['--version']])(
    'still speaks for `mcp %s`, which starts no server',
    async (flag) => {
      // Stripping every `-` argument before deciding made this look like the
      // bare `mcp` command. A suppression rule that fires on the wrong input
      // is how one eventually fails to fire on the right one.
      const notice = startUpdateCheck(baseDeps({ argv: ['mcp', flag] }));
      expect(await notice.finish()).toBe('1.1.0');
    },
  );
});
