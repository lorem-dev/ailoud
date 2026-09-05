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

export interface NpmRegistryOptions {
  readonly registry?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

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
  private readonly fetchImpl: typeof fetch;

  constructor(options: NpmRegistryOptions = {}) {
    this.registry = options.registry ?? REGISTRY;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async published(packageName: string): Promise<readonly PublishedVersion[]> {
    // Same escaping npm itself uses: the slash in a scoped name would
    // otherwise be a path separator.
    const url = `${this.registry}/${packageName.replaceAll('/', '%2f')}`;
    const response = await this.fetchImpl(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new FailureError(
        `the npm registry answered ${response.status} for ${packageName}, so ailoud cannot tell which versions exist.`,
      );
    }
    const body: unknown = await response.json();
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
 */
function isDeprecated(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const flag: unknown = (entry as { deprecated?: unknown }).deprecated;
  if (typeof flag === 'string') return flag.length > 0;
  // Not a shape npm documents, but a boolean true is unambiguous if it appears.
  return flag === true;
}
