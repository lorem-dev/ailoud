// The dependency-age rule, apart from the command that applies it.
//
// Pure and I/O-free so the rule is testable without the network, and so the
// file that exports it can be imported without running a CLI.
export const DEFAULT_DAYS = 14;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** An exact version, as this project pins them. Anything else is not aged. */
export const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The manifests whose direct dependencies are this project's decisions. */
export const MANIFESTS = [
  'package.json',
  'packages/core/package.json',
  'packages/providers/package.json',
  'apps/cli/package.json',
];

/**
 * Every direct dependency across the manifests, as name -> spec.
 *
 * Workspace siblings are skipped: `workspace:*` is not a registry version, and
 * the packages it names are ours to trust or not on other grounds.
 */
export function collectDependencies(read) {
  const found = new Map();
  for (const manifest of MANIFESTS) {
    const parsed = JSON.parse(read(manifest));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(parsed[field] ?? {})) {
        if (spec.startsWith('workspace:')) continue;
        found.set(name, spec);
      }
    }
  }
  return found;
}

/**
 * Sorts `entries` into what fails the rule, what is exempt, and what cannot be
 * judged.
 *
 * `entries` is `[name, spec, publishedAtMs]`; a null time means the registry
 * reported none, which is surfaced rather than treated as old -- treating it
 * as old would hide exactly the version whose metadata is odd.
 *
 * `exceptions` maps `name@version` to a reason. The rule has to yield to a
 * critical advisory: waiting two weeks with a known exploit is worse than
 * installing a version nobody has audited yet. Exempting one is a decision
 * that belongs in the repository with its reason attached, not an argument
 * someone remembers to pass.
 */
export function classify(entries, nowMs, days, exceptions = {}) {
  const cutoff = nowMs - days * DAY_MS;
  const young = [];
  const exempt = [];
  const unknown = [];
  for (const [name, spec, publishedAtMs] of entries) {
    const reason = exceptions[`${name}@${spec}`];
    if (publishedAtMs === null) {
      unknown.push({ name, spec });
      continue;
    }
    if (publishedAtMs <= cutoff) continue;
    const ageDays = (nowMs - publishedAtMs) / DAY_MS;
    if (reason !== undefined) exempt.push({ name, spec, ageDays, reason });
    else young.push({ name, spec, ageDays });
  }
  return { young, exempt, unknown };
}

/**
 * Exceptions that no longer apply, because the version they cover has aged
 * past the rule or is no longer a dependency.
 *
 * Reported so the file does not accumulate permanent holes: an exception is a
 * statement about one moment, and it stops being true.
 */
export function staleExceptions(exceptions, entries, nowMs, days) {
  const cutoff = nowMs - days * DAY_MS;
  const live = new Map(entries.map(([name, spec, at]) => [`${name}@${spec}`, at]));
  return Object.keys(exceptions).filter((key) => {
    if (!live.has(key)) return true;
    const at = live.get(key);
    return at !== null && at <= cutoff;
  });
}
