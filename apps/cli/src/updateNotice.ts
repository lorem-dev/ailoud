import { z } from 'zod';
import type { Clock, Fs, PublishedVersion } from '@ailoud/core';
import { chooseUpdateTarget } from '@ailoud/core';

/** How long a cached answer is trusted before this run asks the registry again. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Resolves at once with whichever the fetch or nothing settles first. */
const SENTINEL = Symbol('update-check-not-settled');

/**
 * How long any single `Fs` call on this path may take. A local cache read is
 * sub-millisecond, so this is generous for a healthy disk and decisive on a
 * sick one (a network home directory, a sleeping external drive, a
 * contended or nearly full disk). Any timeout here means "say nothing" --
 * never an error, and never a claim of being up to date.
 *
 * `finish()` below reuses this same value to bound how much longer it will
 * wait, past its own call, for the in-flight check to settle -- but that is
 * NOT the same as bounding the registry round trip itself to 50ms. By the
 * time `finish()` runs, the disk read has already had the command's own
 * work (plus this much again) to complete, so a cache hit almost always
 * wins outright; a cache MISS instead falls through to the live fetch,
 * which this bound then gives up WAITING for. Giving up still aborts the
 * fetch (so the process can exit right away instead of lingering on the
 * network), but see `startUpdateCheck`'s own doc comment for why an abort
 * must never be confused with a genuine answer worth caching.
 */
const BOUND_MS = 50;

/**
 * Races `promise` against an unref'd timer of `BOUND_MS`, rejecting if the
 * timer wins. Every caller on this path already treats any rejection here
 * identically to a real I/O error, so a slow disk costs at most `BOUND_MS`,
 * never the disk's own unbounded worst case. The timer is unref'd for the
 * same reason `sentinelAfter`'s is below: it must never itself be the thing
 * that keeps a command's process alive.
 */
function withFsTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fs call exceeded its bound')), BOUND_MS);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Resolves to SENTINEL after `ms`, and never before. The timer backing this
 * is unref'd: an unref'd timer does not count against Node keeping the
 * event loop open, so a command whose own work is already done still exits
 * right away, exactly as if this timer did not exist. Without `unref()`
 * here, this bounded wait would itself reintroduce the very delay this
 * module exists to avoid -- do not "simplify" it away.
 */
function sentinelAfter(ms: number): Promise<typeof SENTINEL> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(SENTINEL), ms);
    timer.unref();
  });
}

/** Everything `startUpdateCheck` needs, so a test never touches a real clock,
 * filesystem, network, environment or `process.argv`. */
export interface NoticeDeps {
  readonly fs: Fs;
  readonly clock: Clock;
  /** `AiloudPaths.userDataDir`: always per-user, never a project's `.ailoud/`. */
  readonly userDataDir: string;
  readonly currentVersion: string;
  /** `process.argv.slice(2)`: the words after the node binary and script path. */
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  /** Whether stderr is attached to a real terminal, not a pipe or a log file. */
  readonly stderrIsTTY: boolean;
  /** The `update.check` config key. */
  readonly checkEnabled: boolean;
  /** Fetches the published versions, honoring `signal` for cancellation. */
  readonly published: (signal: AbortSignal) => Promise<readonly PublishedVersion[]>;
}

/** What `finish()` answers: the version to mention, or null for "say nothing". */
export interface UpdateCheck {
  /** Resolves at once: the settled result, or null if it has not arrived. */
  finish(): Promise<string | null>;
}

/** True when `--json` appears anywhere on the command line, or when
 * `--format json` does (`ailoud show <id> --format json`): both put
 * machine-readable output on stdout, and with stdout and stderr merged (a
 * redirect, or any tool that captures both) this notice would land inside
 * it either way. Machine output stays machine output. */
function hasJsonFlag(argv: readonly string[]): boolean {
  if (argv.includes('--json')) return true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--format') return argv[i + 1] === 'json';
    if (arg !== undefined && arg.startsWith('--format=')) {
      return arg.slice('--format='.length) === 'json';
    }
  }
  return false;
}

/** True only for the bare `mcp` command, which speaks the MCP protocol over
 * stdout for as long as the client stays connected -- never `mcp install`,
 * which is an ordinary one-shot CLI command like any other. */
function isServingMcp(argv: readonly string[]): boolean {
  const words = argv.filter((arg) => !arg.startsWith('-'));
  return words[0] === 'mcp' && words[1] === undefined;
}

/** True for `self check` and `self update` themselves (every spelling: the
 * group form, its one-letter alias, and the hidden top-level alias) -- they
 * just said it in full, so a passive mention right after would be noise. */
function isSelfCheckOrUpdate(argv: readonly string[]): boolean {
  const words = argv.filter((arg) => !arg.startsWith('-'));
  const [first, second] = words;
  if (first === 'check' || first === 'update') return true;
  if (first !== 'self') return false;
  return second === 'check' || second === 'c' || second === 'update' || second === 'u';
}

function suppressed(deps: NoticeDeps): boolean {
  if (!deps.stderrIsTTY) return true;
  if (hasJsonFlag(deps.argv)) return true;
  if (isServingMcp(deps.argv)) return true;
  if (deps.env['AILOUD_NO_UPDATE_CHECK'] !== undefined) return true;
  if (!deps.checkEnabled) return true;
  if (isSelfCheckOrUpdate(deps.argv)) return true;
  return false;
}

const CacheSchema = z.object({
  checkedAt: z.string(),
  target: z.string().nullable(),
});

type CacheEntry = z.infer<typeof CacheSchema>;

/** Where the once-a-day cache lives: per-user, like the project registry and
 * the update log, so being inside a project library never scopes it down. */
export function updateCachePath(userDataDir: string): string {
  return `${userDataDir}/update-check.json`;
}

/** The cached answer, or null when there is none, it does not parse, or it
 * has aged past the 24 hour TTL. A cache that fails to read never throws:
 * the worst outcome is one extra check, not a broken command. */
async function readCache(deps: NoticeDeps): Promise<CacheEntry | null> {
  const path = updateCachePath(deps.userDataDir);
  let raw: string;
  try {
    if (!(await withFsTimeout(deps.fs.exists(path)))) return null;
    raw = await withFsTimeout(deps.fs.readTextFile(path));
  } catch {
    return null;
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = CacheSchema.safeParse(document);
  if (!result.success) return null;
  const ageMs = Date.parse(deps.clock.nowIso()) - Date.parse(result.data.checkedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > TTL_MS) return null;
  return result.data;
}

/** Writes the cache, on a success or a failure alike -- see this module's own
 * doc comment on `startUpdateCheck` for why a failure is cached too. Never
 * throws: a directory that cannot be written costs one extra check a day,
 * not a crash of whatever command triggered it. */
async function writeCache(deps: NoticeDeps, target: string | null): Promise<void> {
  const entry: CacheEntry = { checkedAt: deps.clock.nowIso(), target };
  try {
    await withFsTimeout(deps.fs.ensureDir(deps.userDataDir));
    await withFsTimeout(
      deps.fs.writeTextFile(updateCachePath(deps.userDataDir), `${JSON.stringify(entry)}\n`),
    );
  } catch {
    // Best effort, as above.
  }
}

/**
 * Starts a once-a-day, best-effort check for a newer `ailoud`, without ever
 * making a command slower.
 *
 * The fetch (or the cache read behind it) is started here and deliberately
 * NOT awaited: awaiting the network before a command's own work is done
 * would add up to `updateTimeoutMs` to every single run of, say, `ailoud
 * ls`. Suppression is checked FIRST, synchronously, so a suppressed run
 * never starts a fetch at all -- there is nothing to abort and nothing to
 * cache.
 *
 * `finish()` is how a caller collects the answer without ever waiting long
 * for it: it races the in-flight check against `sentinelAfter(BOUND_MS)`, an
 * unref'd timer of about 50ms -- not, as an earlier version of this module
 * did, an ALREADY-RESOLVED sentinel promise. That older race was a single
 * microtask, which sounds free but was not: a real fetch or disk read can
 * never win a race against a promise that has already resolved, because the
 * sentinel's continuation runs before the event loop even reaches the phase
 * where that answer could arrive. Racing against a real, if small, timer
 * instead gives a fast, healthy check a genuine chance to settle first. If
 * it does, its answer wins. If it does not, the timer wins instead:
 * `finish()` aborts the in-flight check (so the process is free to exit
 * right away, rather than lingering until the network gives up on its own)
 * and returns null. The timer being unref'd is what keeps this bounded wait
 * from ever being able to make a command slower than `BOUND_MS` on its own:
 * an unref'd timer never counts against the event loop staying open, so a
 * command whose own work is already done still exits immediately. The next
 * run's cache read is what prints from the attempt this one could not
 * finish.
 *
 * A GENUINE failure is cached as null too, exactly like "no update found": a
 * version check must never read as news, and caching the failure is what
 * limits a broken registry (a bad HTTP status, an unreadable body, a
 * connection that fails on its own) to one wasted attempt a day rather than
 * one per command.
 *
 * An ABORT -- `finish()` giving up on this check and calling
 * `controller.abort()` -- is deliberately NOT a genuine failure and is never
 * cached. Caching it would be indistinguishable from a completed check that
 * found nothing, and for a fast command (`ailoud ls`, `ailoud search`, most
 * of them) the fetch is *always* aborted before a real registry round trip
 * can finish: bounding `finish()`'s wait is what keeps this module from ever
 * making a command slower, but it also means a fast command can basically
 * never be the one to complete its own fetch. Caching that as "no update"
 * would have made the notice permanently unreachable -- exactly the defect
 * this doc comment now exists to prevent. Instead, `finish()` still aborts
 * the fetch when it gives up (so the process is free to exit right away),
 * but the abort itself writes NOTHING to the cache: the next run (of
 * anything) starts fresh and tries again. The consequence to accept is that
 * the cache only ever gets a genuine answer from a command slow enough to
 * outlast the round trip -- `transcribe`, `summarize`, `setup`, or any run
 * against an already-warm connection -- and every fast command in between
 * prints from whatever one of those left behind. That is the honest shape
 * of "never delay, but still eventually say something": only the WAIT for
 * the fetch is bounded, never the fetch's own right to keep running and to
 * report a genuine answer whenever it actually settles.
 */
export function startUpdateCheck(deps: NoticeDeps): UpdateCheck {
  if (suppressed(deps)) return { finish: async () => null };

  const controller = new AbortController();

  const inflight = (async (): Promise<string | null> => {
    const cached = await readCache(deps);
    if (cached !== null) return cached.target;
    try {
      const versions = await deps.published(controller.signal);
      const target = chooseUpdateTarget(deps.currentVersion, versions);
      await writeCache(deps, target);
      return target;
    } catch {
      if (controller.signal.aborted) {
        // WE did this, by giving up in finish() below -- not the registry.
        // An abort says nothing about whether a newer version exists, so
        // nothing is written: see this function's own doc comment for why
        // caching it here is exactly the defect that made the notice
        // unreachable in the first place.
        return null;
      }
      // A genuine failure: the registry answered, badly, or the connection
      // failed on its own. Caching it is what limits a broken network to
      // one wasted attempt a day rather than one per command.
      await writeCache(deps, null);
      return null;
    }
  })();

  return {
    async finish(): Promise<string | null> {
      // Whichever wins: the check, or the bounded wait. The wait's timer is
      // unref'd (see `sentinelAfter`), so it alone can never keep the
      // process alive -- do not replace it with a plain timer "for
      // simplicity"; that would reintroduce exactly the delay this module
      // exists to avoid.
      const raced = await Promise.race([inflight, sentinelAfter(BOUND_MS)]);
      if (raced === SENTINEL) {
        controller.abort();
        return null;
      }
      return raced;
    },
  };
}
