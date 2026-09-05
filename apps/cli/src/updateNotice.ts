import https from 'node:https';
import { z } from 'zod';
import type { Clock, Fs, PublishedVersion } from '@ailoud/core';
import { chooseUpdateTarget } from '@ailoud/core';

/** The only package this passive check ever asks the registry about. */
const PACKAGE_NAME = 'ailoud';

/** How long a cached answer is trusted before this run asks the registry again. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Resolves at once with whichever the fetch or nothing settles first. */
const SENTINEL = Symbol('update-check-not-settled');

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

/** True when `--json` appears anywhere on the command line: machine output
 * stays machine output. */
function hasJsonFlag(argv: readonly string[]): boolean {
  return argv.includes('--json');
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
    if (!(await deps.fs.exists(path))) return null;
    raw = await deps.fs.readTextFile(path);
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
    await deps.fs.ensureDir(deps.userDataDir);
    await deps.fs.writeTextFile(updateCachePath(deps.userDataDir), `${JSON.stringify(entry)}\n`);
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
 * `finish()` is how a caller collects the answer without ever waiting for
 * it: it races the in-flight check against an ALREADY-RESOLVED sentinel
 * promise. That race is a single microtask, never a timer, so nothing here
 * keeps the event loop alive. If the real check has already settled by the
 * time `finish()` runs -- because the command itself took long enough --
 * its answer wins the race. If it has not, the sentinel wins instead:
 * `finish()` aborts the in-flight check (so the process is free to exit
 * right away, rather than lingering until the network gives up on its own)
 * and returns null. The next run's cache read is what prints from the
 * attempt this one could not finish.
 *
 * A failed or timed-out check is cached as null, exactly like "no update
 * found": a version check must never read as news, and caching the failure
 * is what limits a broken network to one wasted attempt a day rather than
 * one per command.
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
      await writeCache(deps, null); // a failure is cached too: one attempt a day
      return null;
    }
  })();

  return {
    async finish(): Promise<string | null> {
      // Whichever wins: the check, or nothing at all. No timer keeps the
      // event loop alive, and no caller ever waits.
      const raced = await Promise.race([inflight, Promise.resolve(SENTINEL)]);
      if (raced === SENTINEL) {
        controller.abort();
        return null;
      }
      return raced;
    },
  };
}

/**
 * A minimal, direct HTTPS GET against the npm registry, used only by this
 * passive check -- deliberately not `context.versionSource` (`self check`'s
 * `NpmRegistry`, built on `fetch`).
 *
 * Aborting a `fetch` rejects its promise almost at once, but the pooled TCP
 * connection underneath keeps running -- and keeps the event loop, and so
 * the process, alive -- for undici's own internal connect timeout regardless
 * of that abort. Measured directly against an unroutable address: several
 * extra seconds after the abort, every time. That is exactly the delay this
 * feature exists to never cause. `https.request`'s own `signal` option
 * destroys the underlying socket the instant it fires, which is what lets
 * the process actually exit the moment `finish()` gives up on it.
 */
export function registryPublished(
  host: string,
): (signal: AbortSignal) => Promise<readonly PublishedVersion[]> {
  return (signal) =>
    new Promise<readonly PublishedVersion[]>((resolve, reject) => {
      const request = https.request(
        {
          host,
          path: `/${PACKAGE_NAME}`,
          headers: { accept: 'application/vnd.npm.install-v1+json' },
          signal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new Error(`the npm registry answered ${status} for ${PACKAGE_NAME}`));
              return;
            }
            try {
              const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              resolve(parsePublished(body));
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          });
        },
      );
      request.on('error', reject);
      request.end();
    });
}

function parsePublished(body: unknown): readonly PublishedVersion[] {
  const versions =
    typeof body === 'object' && body !== null
      ? (body as { versions?: unknown }).versions
      : undefined;
  if (typeof versions !== 'object' || versions === null) {
    throw new Error(`the npm registry returned no versions for ${PACKAGE_NAME}`);
  }
  return Object.entries(versions as Record<string, unknown>).map(([version, entry]) => ({
    version,
    deprecated: isDeprecated(entry),
  }));
}

/** Same rule `NpmRegistry` uses in packages/providers: the deprecation
 * MESSAGE lives in this field, and an empty string un-deprecates -- so
 * presence alone is not the test. */
function isDeprecated(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const flag: unknown = (entry as { deprecated?: unknown }).deprecated;
  if (typeof flag === 'string') return flag.length > 0;
  return flag === true;
}
