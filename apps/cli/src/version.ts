import { readFileSync } from 'node:fs';

/**
 * The CLI's own version, read from its manifest.
 *
 * It used to be the literal `0.0.0` passed to commander, so the published
 * 1.0.0-dev.1 answered `ailoud --version` with 0.0.0 and told every MCP client
 * the same. The manifest is the one place a release already updates, and it
 * ships inside the tarball, so it is the only copy that cannot go stale.
 *
 * Resolved relative to this module rather than to the working directory:
 * `dist/version.js` sits one level below the package root both in the
 * repository and in an installed package.
 */
export const VERSION: string = readVersion();

function readVersion(): string {
  const manifest = new URL('../package.json', import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  const version =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { version?: unknown }).version
      : undefined;
  if (typeof version !== 'string' || version === '') {
    throw new Error(`no version in ${manifest.pathname}`);
  }
  return version;
}
