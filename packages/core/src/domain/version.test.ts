import { describe, expect, it } from 'vitest';
import { chooseUpdateTarget, compareVersions, isDeprecated, parseVersion } from './version.js';

const published = (...versions: string[]) =>
  versions.map((version) => ({ version, deprecated: false }));

describe('parseVersion', () => {
  it('reads a final release', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
  });

  it('reads a dev snapshot', () => {
    expect(parseVersion('1.2.3-dev.4')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      pre: { kind: 'dev', n: 4 },
    });
  });

  it('reads a release candidate', () => {
    expect(parseVersion('1.2.3-rc.1')?.pre).toEqual({ kind: 'rc', n: 1 });
  });

  it.each(['', '1.2', '1.2.3.4', 'v1.2.3', '1.2.3-beta.1', '1.2.3-dev', '1.2.3-dev.x'])(
    'refuses %o',
    (text) => {
      expect(parseVersion(text)).toBeNull();
    },
  );
});

describe('compareVersions', () => {
  it('sorts a release above its own pre-releases', () => {
    // Semver precedence, and the one people get wrong: 1.0.0 > 1.0.0-dev.5.
    const release = parseVersion('1.0.0')!;
    const snapshot = parseVersion('1.0.0-dev.5')!;
    expect(compareVersions(release, snapshot)).toBeGreaterThan(0);
  });

  it('sorts pre-releases of one base by their index', () => {
    expect(
      compareVersions(parseVersion('1.0.0-dev.10')!, parseVersion('1.0.0-dev.9')!),
    ).toBeGreaterThan(0);
  });

  it('sorts rc above dev of the same base', () => {
    expect(
      compareVersions(parseVersion('1.0.0-rc.1')!, parseVersion('1.0.0-dev.9')!),
    ).toBeGreaterThan(0);
  });

  it('is zero for equal versions', () => {
    expect(compareVersions(parseVersion('2.0.1-rc.3')!, parseVersion('2.0.1-rc.3')!)).toBe(0);
  });
});

describe('chooseUpdateTarget', () => {
  it('offers the newest final to a final', () => {
    expect(chooseUpdateTarget('1.0.0', published('1.0.0', '1.0.1', '1.1.0'))).toBe('1.1.0');
  });

  it('offers a newer dev of the same base to a dev', () => {
    expect(chooseUpdateTarget('1.0.0-dev.3', published('1.0.0-dev.3', '1.0.0-dev.4'))).toBe(
      '1.0.0-dev.4',
    );
  });

  it('offers the very next dev, so i >= 1', () => {
    expect(chooseUpdateTarget('1.0.0-dev.1', published('1.0.0-dev.2'))).toBe('1.0.0-dev.2');
  });

  it('prefers the final over a newer snapshot of the same base', () => {
    expect(chooseUpdateTarget('1.0.0-dev.3', published('1.0.0-dev.4', '1.0.0'))).toBe('1.0.0');
  });

  it('refuses to move a final onto a pre-release', () => {
    expect(chooseUpdateTarget('1.0.0', published('1.1.0-dev.1', '1.1.0-rc.1'))).toBeNull();
  });

  it('refuses to cross pre-release kind', () => {
    expect(chooseUpdateTarget('1.0.0-dev.3', published('1.0.0-rc.1'))).toBeNull();
  });

  it('refuses a pre-release of another base', () => {
    expect(chooseUpdateTarget('1.0.0-dev.3', published('1.1.0-dev.1'))).toBeNull();
  });

  it('never offers a deprecated version', () => {
    // What `pnpm retire` leaves behind: every superseded snapshot deprecated.
    const available = [
      { version: '1.0.0-dev.9', deprecated: true },
      { version: '1.0.0', deprecated: false },
    ];
    expect(chooseUpdateTarget('1.0.0-dev.3', available)).toBe('1.0.0');
  });

  it('answers null when nothing is newer', () => {
    expect(chooseUpdateTarget('1.1.0', published('1.0.0', '1.1.0'))).toBeNull();
  });

  it('works when the running version was never published', () => {
    // A locally built snapshot. Targets come from ordering, not from finding
    // the current version in the list.
    expect(chooseUpdateTarget('1.1.0-dev.0', published('1.1.0-dev.1'))).toBe('1.1.0-dev.1');
  });

  it('ignores versions it cannot parse', () => {
    expect(chooseUpdateTarget('1.0.0', published('1.0.1', 'not-a-version'))).toBe('1.0.1');
  });

  it('throws when its own version is unparseable', () => {
    expect(() => chooseUpdateTarget('nonsense', published('1.0.0'))).toThrow(/nonsense/);
  });
});

describe('isDeprecated', () => {
  // The single rule both `packages/providers/src/update/npmRegistry.ts` and
  // `apps/cli/src/updateNotice.ts` import from here -- so this file is what
  // keeps the two call sites from drifting apart again, the way they did
  // before this rule had one home.
  it('treats an empty deprecation message as not deprecated', () => {
    // `npm deprecate <pkg>@<version> ""` un-deprecates by setting an empty
    // string rather than removing the field. Testing the key's presence
    // rather than the value reports a revived version as still deprecated.
    expect(isDeprecated({ deprecated: '' })).toBe(false);
  });

  it('treats a non-empty deprecation message as deprecated', () => {
    expect(isDeprecated({ deprecated: 'do not use' })).toBe(true);
  });

  it('treats a boolean true as deprecated', () => {
    expect(isDeprecated({ deprecated: true })).toBe(true);
  });

  it('treats a missing field as not deprecated', () => {
    expect(isDeprecated({})).toBe(false);
  });

  it('treats a non-object entry as not deprecated', () => {
    expect(isDeprecated(null)).toBe(false);
    expect(isDeprecated('nope')).toBe(false);
  });
});
