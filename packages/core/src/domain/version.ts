/** A version this project produces: `X.Y.Z`, `X.Y.Z-dev.N` or `X.Y.Z-rc.N`. */
export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** null for a final release. */
  readonly pre: { readonly kind: PreKind; readonly n: number } | null;
}

export type PreKind = 'dev' | 'rc';

/** One version as the registry reports it. */
export interface PublishedVersion {
  readonly version: string;
  readonly deprecated: boolean;
}

// Deliberately narrow. The only pre-release kinds this project publishes are
// `dev` and `rc` (see the tag table in AGENTS.md), and a parser that accepted
// `beta` would be inventing a policy for a version nobody can produce.
const PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-(dev|rc)\.(\d+))?$/;

export function parseVersion(text: string): Version | null {
  const match = PATTERN.exec(text);
  if (match === null) return null;
  const [, major, minor, patch, kind, n] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    pre: kind === undefined ? null : { kind: kind as PreKind, n: Number(n) },
  };
}

/** rc outranks dev, matching semver's dictionary order on the identifier. */
const KIND_RANK: Record<PreKind, number> = { dev: 0, rc: 1 };

export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // Semver precedence: a pre-release sorts BELOW the release it leads to, so
  // 1.0.0 > 1.0.0-dev.5. This is what makes "a snapshot can move to its own
  // final release" fall out of the ordering instead of needing a special case.
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  if (a.pre.kind !== b.pre.kind) return KIND_RANK[a.pre.kind] - KIND_RANK[b.pre.kind];
  return a.pre.n - b.pre.n;
}

/**
 * The newest version `current` is allowed to move to, or null.
 *
 * The policy, which exists because a snapshot is not a lesser release but a
 * different line of them:
 *
 * - A final release moves only to a newer final release. Offering a snapshot
 *   to someone on a release would hand them less tested code than they have.
 * - A pre-release moves to a newer pre-release OF THE SAME KIND AND BASE, or
 *   to any newer final. `1.0.0-dev.3` may take `1.0.0-dev.4` or `1.0.0`, and
 *   may not take `1.1.0-dev.1` -- that is a different version's line of
 *   snapshots, and stepping sideways into it skips whatever `1.0.0` became.
 * - A deprecated version is never a target. `pnpm retire` deprecates every
 *   superseded snapshot, so this is what keeps a retired `-dev.9` from being
 *   offered in place of the `1.0.0` that replaced it.
 */
export function chooseUpdateTarget(
  current: string,
  available: readonly PublishedVersion[],
): string | null {
  const from = parseVersion(current);
  if (from === null) {
    throw new Error(
      `ailoud cannot read its own version ${JSON.stringify(current)}, so it cannot tell what to update to.`,
    );
  }

  let best: { text: string; version: Version } | null = null;
  for (const candidate of available) {
    if (candidate.deprecated) continue;
    const to = parseVersion(candidate.version);
    if (to === null) continue;
    if (compareVersions(to, from) <= 0) continue;
    if (!isEligible(from, to)) continue;
    if (best === null || compareVersions(to, best.version) > 0) {
      best = { text: candidate.version, version: to };
    }
  }
  return best?.text ?? null;
}

function isEligible(from: Version, to: Version): boolean {
  if (to.pre === null) return true;
  if (from.pre === null) return false;
  if (from.pre.kind !== to.pre.kind) return false;
  return to.major === from.major && to.minor === from.minor && to.patch === from.patch;
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
 * The single copy of this rule: `packages/providers/src/update/npmRegistry.ts`
 * and `apps/cli/src/updateNotice.ts` both import it from here rather than
 * keeping their own copy, so the rule can only drift once.
 */
export function isDeprecated(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const flag: unknown = (entry as { deprecated?: unknown }).deprecated;
  if (typeof flag === 'string') return flag.length > 0;
  // Not a shape npm documents, but a boolean true is unambiguous if it appears.
  return flag === true;
}
