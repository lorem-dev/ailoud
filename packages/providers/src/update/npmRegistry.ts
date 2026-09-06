import { request as httpsRequest } from 'node:https';
import type { PublishedVersion, VersionSource } from '@ailoud/core';
import { FailureError } from '@ailoud/core';

/**
 * Exported so callers report the same host and wait that this class would use
 * by default. Two copies of these numbers drift, and then `self check` names a
 * timeout the registry client never applied.
 */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const DEFAULT_TIMEOUT_MS = 10_000;

const REGISTRY = DEFAULT_REGISTRY;
const TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

/**
 * Fetches one URL and reports its status and body text.
 *
 * A seam rather than `fetch` itself, for a measured reason: aborting a `fetch`
 * does NOT release the socket, so a process that gives up on a request still
 * waits about 10.5 seconds to exit (Node 24, measured against an
 * unresponsive address). `https.request`'s native `signal` destroys the
 * socket at once and the process exits in about 60ms. The background update
 * check must abandon a request the instant a command is ready to finish, so
 * that difference decides the implementation -- and it is the whole reason
 * this class, rather than a second hand-rolled client, can serve both callers.
 */
export type RegistryTransport = (
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<{ readonly status: number; readonly body: string }>;

export interface NpmRegistryOptions {
  readonly registry?: string;
  readonly timeoutMs?: number;
  /** Injected in tests, so a unit test never opens a socket. */
  readonly transport?: RegistryTransport;
}

const httpsTransport: RegistryTransport = (url, headers, signal) =>
  new Promise((resolve, reject) => {
    const request = httpsRequest(url, { headers, signal }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    request.on('error', reject);
    request.end();
  });

/**
 * Which versions of a package exist, read from the npm registry.
 *
 * Only the abbreviated packument is requested (the `accept` header below),
 * which still carries every version's `deprecated` flag -- the field the
 * whole update policy turns on -- at a fraction of the size of the full
 * document.
 */
export class NpmRegistry implements VersionSource {
  private readonly registry: string;
  private readonly timeoutMs: number;
  private readonly transport: RegistryTransport;

  constructor(options: NpmRegistryOptions = {}) {
    this.registry = options.registry ?? REGISTRY;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.transport = options.transport ?? httpsTransport;
  }

  async published(packageName: string, signal?: AbortSignal): Promise<readonly PublishedVersion[]> {
    // Same escaping npm itself uses: the slash in a scoped name would
    // otherwise be a path separator.
    const url = `${this.registry}/${packageName.replaceAll('/', '%2f')}`;
    // The caller's cancellation AND our own timeout: whichever fires first
    // wins. A caller that passes no signal still gets the timeout.
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    const response = await this.transport(
      url,
      { accept: 'application/vnd.npm.install-v1+json' },
      combined,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new FailureError(
        `the npm registry answered ${response.status} for ${packageName}, so ailoud cannot tell which versions exist.`,
      );
    }
    const body: unknown = JSON.parse(response.body);
    const versions =
      typeof body === 'object' && body !== null
        ? (body as { versions?: unknown }).versions
        : undefined;
    if (typeof versions !== 'object' || versions === null) {
      throw new FailureError(
        `the npm registry returned no versions for ${packageName}, so ailoud cannot tell which versions exist.`,
      );
    }
    const published = Object.entries(versions as Record<string, unknown>).map(
      ([version, entry]) => ({ version, deprecated: isDeprecated(entry) }),
    );
    // An empty list is not an answer. `{"versions": {}}` with a 200 would
    // otherwise resolve to [], which every caller reads as "nothing newer
    // exists" -- the one wrong thing a version check can say. A package that
    // really has no versions cannot be the one we are running.
    if (published.length === 0) {
      throw new FailureError(
        `the npm registry listed no versions of ${packageName}, so ailoud cannot tell which versions exist.`,
      );
    }
    return published;
  }
}

/**
 * Whether the registry says this version is deprecated.
 *
 * The value matters, not the key. npm stores the deprecation MESSAGE here, and
 * `npm deprecate <pkg>@<version> ""` un-deprecates by setting an empty string
 * rather than removing the field. Testing `'deprecated' in entry` therefore
 * reports a revived version as still deprecated, which would refuse a
 * legitimate update and, if a registry emitted the empty form widely, refuse
 * every update.
 *
 * It lives HERE, in the provider, rather than in the domain: it decodes one
 * field of npm's packument wire format, which is a provider's business and
 * not a rule about versions. `apps/cli` reaches it through this package, so
 * nothing needs a copy.
 *
 * `scripts/retire-prereleases.mjs` answers a related question with its own
 * truthiness test, deliberately, and says why there. It is NOT importing this
 * function, so do not describe this as the only copy -- an earlier version of
 * this comment did, which made it false.
 */
export function isDeprecated(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const flag: unknown = (entry as { deprecated?: unknown }).deprecated;
  if (typeof flag === 'string') return flag.length > 0;
  // Not a shape npm documents, but a boolean true is unambiguous if it appears.
  return flag === true;
}
