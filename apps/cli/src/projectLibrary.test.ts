import { describe, expect, it } from 'vitest';
import { PROJECT_DIR, findProjectDir, resolvePaths } from './config.js';

const HOME = { HOME: '/home/ann' };

/** An existence predicate over a fixed set of directories. */
const has =
  (...dirs: string[]) =>
  (path: string) =>
    dirs.includes(path);

describe('findProjectDir', () => {
  it('finds one in the directory itself', () => {
    expect(findProjectDir('/work/repo', has('/work/repo/.ailoud'))).toBe('/work/repo/.ailoud');
  });

  it('walks upwards, so a subdirectory still finds the project library', () => {
    // The reason this is a search and not a check: work happens in
    // subdirectories, and a library that vanished depending on which one you
    // stood in would be worse than no feature.
    expect(findProjectDir('/work/repo/apps/cli/src', has('/work/repo/.ailoud'))).toBe(
      '/work/repo/.ailoud',
    );
  });

  it('takes the nearest one when there are two', () => {
    expect(
      findProjectDir('/work/repo/sub', has('/work/repo/.ailoud', '/work/repo/sub/.ailoud')),
    ).toBe('/work/repo/sub/.ailoud');
  });

  it('returns null when there is none, without looping at the root', () => {
    expect(findProjectDir('/work/repo', has())).toBeNull();
    expect(findProjectDir('/', has())).toBeNull();
  });

  it('is named once, so the directory name cannot drift', () => {
    expect(PROJECT_DIR).toBe('.ailoud');
  });
});

describe('resolvePaths', () => {
  it('uses the per-user library when no project directory is looked for', () => {
    const paths = resolvePaths({ ...HOME, XDG_DATA_HOME: '/data' });
    expect(paths.dataDir).toBe('/data/ailoud');
    expect(paths.dbFile).toBe('/data/ailoud/ailoud.db');
    expect(paths.isProjectLibrary).toBe(false);
  });

  it('uses the project library when one exists at or above the working directory', () => {
    const paths = resolvePaths(
      { ...HOME, XDG_DATA_HOME: '/data' },
      { cwd: '/work/repo/src', exists: has('/work/repo/.ailoud') },
    );
    expect(paths.dataDir).toBe('/work/repo/.ailoud');
    expect(paths.dbFile).toBe('/work/repo/.ailoud/ailoud.db');
    expect(paths.mediaRoot).toBe('/work/repo/.ailoud/media');
    expect(paths.isProjectLibrary).toBe(true);
  });

  it('keeps the config per-user even with a project library', () => {
    // The config names installed binaries and model files. Making it local
    // would mean re-downloading a 488 MB model per repository.
    const paths = resolvePaths(
      { ...HOME, XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data' },
      { cwd: '/work/repo', exists: has('/work/repo/.ailoud') },
    );
    expect(paths.configFile).toBe('/cfg/ailoud/config.yaml');
  });

  it('falls back to the per-user library when the project has none', () => {
    const paths = resolvePaths(
      { ...HOME, XDG_DATA_HOME: '/data' },
      { cwd: '/work/repo', exists: has() },
    );
    expect(paths.dataDir).toBe('/data/ailoud');
    expect(paths.isProjectLibrary).toBe(false);
  });

  it('defaults the XDG directories the way the spec says', () => {
    const paths = resolvePaths(HOME);
    expect(paths.configFile).toBe('/home/ann/.config/ailoud/config.yaml');
    expect(paths.dataDir).toBe('/home/ann/.local/share/ailoud');
  });

  it('refuses to guess when HOME is unset', () => {
    expect(() => resolvePaths({})).toThrow(/HOME is not set/);
    expect(() => resolvePaths({ HOME: '' })).toThrow(/HOME is not set/);
  });
});

describe('resolvePaths: XDG variables the spec calls invalid', () => {
  it('treats an exported-but-empty variable as unset', () => {
    // It rooted every path at `/`: `XDG_DATA_HOME= ailoud audio ls` died
    // trying to mkdir `/ailoud`, and an empty XDG_CONFIG_HOME silently read
    // no config while naming `/ailoud/config.yaml` as the file to fix.
    const paths = resolvePaths({ ...HOME, XDG_CONFIG_HOME: '', XDG_DATA_HOME: '' });
    expect(paths.configFile).toBe('/home/ann/.config/ailoud/config.yaml');
    expect(paths.dataDir).toBe('/home/ann/.local/share/ailoud');
  });

  it('ignores a relative value, as the spec requires', () => {
    // Left in, it gave a library that moved with every `cd`.
    const paths = resolvePaths({ ...HOME, XDG_DATA_HOME: 'relativedir' });
    expect(paths.dataDir).toBe('/home/ann/.local/share/ailoud');
  });

  it('ignores whitespace-only, and trims a usable one', () => {
    expect(resolvePaths({ ...HOME, XDG_DATA_HOME: '   ' }).dataDir).toBe(
      '/home/ann/.local/share/ailoud',
    );
    expect(resolvePaths({ ...HOME, XDG_DATA_HOME: ' /data ' }).dataDir).toBe('/data/ailoud');
  });

  it('still honours an absolute value', () => {
    expect(resolvePaths({ ...HOME, XDG_DATA_HOME: '/data' }).dataDir).toBe('/data/ailoud');
  });
});
