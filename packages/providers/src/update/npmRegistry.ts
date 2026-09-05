import type { PublishedVersion, VersionSource } from '@ailoud/core';
import { FailureError } from '@ailoud/core';

const REGISTRY = 'https://registry.npmjs.org';
const TIMEOUT_MS = 10_000;

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
    return Object.entries(versions as Record<string, unknown>).map(([version, entry]) => ({
      version,
      deprecated: typeof entry === 'object' && entry !== null && 'deprecated' in entry,
    }));
  }
}
