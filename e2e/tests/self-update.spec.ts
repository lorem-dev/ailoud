// End-to-end coverage of `ailoud self check|update|sync` and the project
// registry behind `self sync`, driven through the built binary rather than
// in-memory fakes. Tasks 1-12 already proved the logic against fakes; this
// is what proves the wiring around it -- process spawning, file paths,
// `projects.json` -- is real.
//
// No spec here ever reaches a real `npm install -g` or `pnpm add -g`. Run
// from its own checkout, the repository's own binary is never an installed
// `npm-global` or `pnpm-global` copy, so `self update` naturally refuses with
// a hint instead of installing anything -- see the "refuses" specs below,
// which exercise that natural path with no stubbing at all. The one spec
// that needs the OTHER branch, to see `--dry-run`'s plan, reaches it by
// putting a stub `npm` first on PATH that only ever answers `root -g` with
// the repository's own directory. Even that cannot lead to a real install:
// the install command `--dry-run` prints is built from `installCommandFor`
// (packages/providers/src/update/installMethod.ts), anchored to the real
// node binary's own directory, never to anything found on PATH, and
// `--dry-run` returns before any command is ever spawned regardless.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeSandbox } from '../src/cli';
import type { Sandbox } from '../src/cli';

const REPO_ROOT = join(__dirname, '..', '..');

/** A quick, local command; a few seconds is already generous. */
const GIT_STATUS_TIMEOUT_MS = 10_000;

const START = '<!-- AILOUD_START -->';

jest.setTimeout(120_000);

function gitStatus(): string {
  return execFileSync('git', ['status', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: GIT_STATUS_TIMEOUT_MS,
  });
}

// Captured before any sandbox runs, so the final check below can prove THIS
// suite left the repository exactly as it found it -- not that the tree was
// clean to begin with. A developer with uncommitted work is the common case,
// not an edge case, and a check that fails for that reason is a check that
// gets ignored.
const statusBeforeSuite = gitStatus();

const read = (path: string): Promise<string> => readFile(path, 'utf8');

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Mirrors `ProjectEntry` (apps/cli/src/projects.ts), for reading and
 * rewriting `projects.json` directly in a spec. */
interface RegistryEntry {
  readonly path: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly libraryDir?: string;
  readonly rulesVersion?: string;
}

async function readRegistry(path: string): Promise<readonly RegistryEntry[]> {
  return JSON.parse(await read(path)) as readonly RegistryEntry[];
}

/** The version this checkout's own manifest names -- never hard-coded, so a
 * release bump never leaves this file asserting a stale number. */
function currentVersion(): string {
  const manifest = join(REPO_ROOT, 'apps', 'cli', 'package.json');
  const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version === '') {
    throw new Error(`no version in ${manifest}`);
  }
  return parsed.version;
}

/** A newer final release than `version`, which must itself be a final
 * release: `chooseUpdateTarget` only ever offers a final release a newer
 * final release (packages/core/src/domain/version.ts), never a pre-release. */
function newerRelease(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) {
    throw new Error(`apps/cli/package.json's version is not a plain release: ${version}`);
  }
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

/**
 * The registry's document for `ailoud`, written to a fixture file -- never a
 * server. See `AILOUD_PACKUMENTS` in `scripts/retire-prereleases.test.mjs`,
 * whose own doc comment tells the story this follows: an HTTP stub tried
 * here once left a throwing test's server handle open, and the leaked
 * handle hung the entire suite with no failing test to point at, because a
 * per-test timeout does not apply to a handle nobody closed. A file behind
 * an environment variable cannot leak that way -- there is no handle to
 * leave open.
 */
function packumentFixture(dir: string, versions: readonly string[]): string {
  const path = join(dir, 'packuments.json');
  const one = { versions: Object.fromEntries(versions.map((v) => [v, {}])) };
  writeFileSync(path, JSON.stringify({ ailoud: one }));
  return path;
}

/**
 * A directory holding an `npm` that only ever answers `root -g`, with
 * `rootDir` -- for putting first on PATH so `self update --dry-run` detects
 * an `npm-global` install instead of this repository's natural refusal, the
 * one other branch the design calls for exercising. Anything else asked of
 * it fails loudly rather than doing something unexpected.
 */
function stubNpmRoot(dir: string, rootDir: string): string {
  const bin = join(dir, 'stub-bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'npm');
  writeFileSync(
    script,
    `#!/bin/sh\n` +
      `if [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n` +
      `  echo "${rootDir}"\n` +
      `  exit 0\n` +
      `fi\n` +
      `echo "stub npm: unexpected args: $@" >&2\n` +
      `exit 1\n`,
  );
  chmodSync(script, 0o755);
  return bin;
}

describe('ailoud self check', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('reports the target it would take, against a stub registry', async () => {
    const current = currentVersion();
    const target = newerRelease(current);
    const fixture = packumentFixture(sandbox.home, [current, target]);

    const result = await sandbox.run(['self', 'check', '--json'], {
      env: { AILOUD_PACKUMENTS: fixture },
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as {
      current: string;
      target: string | null;
      updatable: boolean;
    };
    expect(parsed.current).toBe(current);
    expect(parsed.target).toBe(target);
    expect(parsed.updatable).toBe(true);
  });
});

describe('ailoud self update', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('prints a plan and changes nothing with --dry-run', async () => {
    const current = currentVersion();
    const target = newerRelease(current);
    const fixture = packumentFixture(sandbox.home, [current, target]);
    const stubBin = stubNpmRoot(sandbox.home, REPO_ROOT);

    const registryBefore = await exists(join(sandbox.dataDir, 'projects.json'));
    expect(registryBefore).toBe(false);

    const result = await sandbox.run(['self', 'update', '--dry-run'], {
      env: {
        AILOUD_PACKUMENTS: fixture,
        PATH: `${stubBin}:${process.env['PATH'] ?? ''}`,
      },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Current version: ${current}`);
    expect(result.stdout).toContain(`Target version: ${target}`);
    expect(result.stdout).toMatch(/Install command: .*npm .*install -g ailoud@/);
    expect(result.stdout).toContain('Dry run: nothing was changed.');

    // No install: nothing this test could observe short of a real global
    // write, which the anchored, never-PATH-resolved install command and
    // the early dry-run return both already rule out.
    // No sweep, no log write, no registry write.
    expect(await exists(join(sandbox.dataDir, 'update.log'))).toBe(false);
    expect(await exists(join(sandbox.dataDir, 'projects.json'))).toBe(false);
  });

  it('refuses to update a project dependency and names the command to run', async () => {
    const current = currentVersion();
    const target = newerRelease(current);
    const fixture = packumentFixture(sandbox.home, [current, target]);

    const result = await sandbox.run(['self', 'update'], {
      env: { AILOUD_PACKUMENTS: fixture },
    });

    // This repository's own checkout is never an npm-global or pnpm-global
    // install, so detectInstallMethod refuses -- naturally, with no stubbing
    // -- and names a command to run instead of installing anything.
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(
      /npm install -g ailoud@|pnpm add -g ailoud@|add command in|npx ailoud@/,
    );
  });

  it('refuses under --force with a non-zero exit', async () => {
    const current = currentVersion();
    const target = newerRelease(current);
    const fixture = packumentFixture(sandbox.home, [current, target]);

    const result = await sandbox.run(['self', 'update', '--force'], {
      env: { AILOUD_PACKUMENTS: fixture },
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/cannot install this way/);
  });
});

describe('ailoud self sync', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('refreshes a rules block, and is idempotent on a second run', async () => {
    const claudeMd = join(sandbox.projectDir, 'CLAUDE.md');

    // `mcp install --location local` registers the project itself, with this
    // build's rules version, the moment it succeeds (see
    // `registerAfterInstall` in apps/cli/src/commands/mcpInstall.ts) -- no
    // second command is needed to put it in projects.json.
    await sandbox.run(['mcp', 'install', '--target', 'claude', '--location', 'local']);

    // Simulate an older ailoud having written a different block, the same
    // way e2e/tests/mcp-install.spec.ts does for `mcp update`.
    const before = await read(claudeMd);
    const stale = before.replace(
      /<!-- AILOUD_START -->[\s\S]*<!-- AILOUD_END -->/,
      `${START}\nold text\n<!-- AILOUD_END -->`,
    );
    await writeFile(claudeMd, stale, 'utf8');

    const first = await sandbox.run(['self', 'sync']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`refreshed: ${sandbox.projectDir}`);
    const refreshed = await read(claudeMd);
    expect(refreshed).not.toContain('old text');
    expect(refreshed).toContain('search_transcripts');

    // Idempotent: a second sweep with nothing stale must say `current`, not
    // `refreshed` -- a sweep over many projects must never claim an edit it
    // did not make, which is the whole reason this command exists.
    const second = await sandbox.run(['self', 'sync']);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`current: ${sandbox.projectDir}`);
    expect(second.stdout).not.toContain(`refreshed: ${sandbox.projectDir}`);
    expect(await read(claudeMd)).toBe(refreshed);
  });

  it('reports and prunes a project whose directory is gone', async () => {
    const goneDir = join(sandbox.home, 'gone-project');
    await mkdir(goneDir, { recursive: true });
    await sandbox.run(['mcp', 'install', '--target', 'claude', '--location', 'local'], {
      cwd: goneDir,
    });

    const registryPath = join(sandbox.dataDir, 'projects.json');
    const before = await readRegistry(registryPath);
    expect(before.some((entry) => entry.path === goneDir)).toBe(true);

    await rm(goneDir, { recursive: true, force: true });

    const result = await sandbox.run(['self', 'sync']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`gone: ${goneDir}`);

    const after = await readRegistry(registryPath);
    expect(after.some((entry) => entry.path === goneDir)).toBe(false);
  });
});

describe('the project registry', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('records a project in projects.json after a command uses its library', async () => {
    const registryPath = join(sandbox.dataDir, 'projects.json');
    expect(await exists(registryPath)).toBe(false);

    // `mcp install --location local` both creates the project library AND
    // registers it (`registerAfterInstall` in
    // apps/cli/src/commands/mcpInstall.ts) -- Task 10's own proof, kept
    // honest here against the real binary.
    const result = await sandbox.run([
      'mcp',
      'install',
      '--target',
      'claude',
      '--location',
      'local',
    ]);
    expect(result.code).toBe(0);

    const registry = await readRegistry(registryPath);
    expect(registry).toHaveLength(1);
    expect(registry[0]?.path).toBe(sandbox.projectDir);
    expect(registry[0]?.rulesVersion).toBeDefined();
  });

  it('keeps projects.json valid when two commands run at once', async () => {
    const dirA = join(sandbox.home, 'project-a');
    const dirB = join(sandbox.home, 'project-b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });

    // Each project's OWN local library is created first, sequentially: with
    // neither directory holding a `.ailoud/` yet, `mcp install` falls back to
    // opening the shared PER-USER library just long enough to write one, and
    // running that step for both projects at once would race two processes
    // on THAT single sqlite file -- a real hazard, but a different one from
    // what this spec is about. One at a time here isolates the race to the
    // one file this spec targets: projects.json.
    await sandbox.run(['mcp', 'install', '--target', 'claude', '--location', 'local'], {
      cwd: dirA,
    });
    await sandbox.run(['mcp', 'install', '--target', 'claude', '--location', 'local'], {
      cwd: dirB,
    });

    const registryPath = join(sandbox.dataDir, 'projects.json');
    // Back-dated past rememberProject's 24-hour throttle (projects.ts), so
    // the concurrent commands below actually write instead of silently
    // no-op'ing on an entry seen moments ago.
    const justRegistered = await readRegistry(registryPath);
    const backdated = justRegistered.map((entry) => ({
      ...entry,
      lastSeen: '2000-01-01T00:00:00.000Z',
    }));
    await writeFile(registryPath, `${JSON.stringify(backdated, null, 2)}\n`, 'utf8');

    // NOW genuinely concurrent: two processes, each already holding its own
    // project-local library (no shared sqlite file left to race on), both
    // touching the one file that IS shared -- projects.json -- at once.
    // `writeRegistry`'s own doc comment (projects.ts) is explicit that its
    // re-read-before-rename only NARROWS the lost-update window to the
    // rename itself, rather than closing it -- a write landing inside that
    // window is expected to lose its OWN timestamp bump, self-healing on the
    // next run, and is not this test's concern. What must never happen is
    // the file going invalid, or either project's entry disappearing
    // outright, which is what is asserted below.
    //
    // And this spec is NOT where the race guarantee is pinned. Two real
    // subprocesses may simply not overlap inside the critical section, so a
    // green run here is evidence rather than proof. The deterministic case --
    // a rival that commits between the re-read and the rename, every time --
    // lives in `apps/cli/src/projects.test.ts` under `RacingFs`. Read that
    // one if you are changing `writeRegistry`; this one only catches a
    // regression crude enough to survive real scheduling.
    await Promise.all([sandbox.run(['ls'], { cwd: dirA }), sandbox.run(['ls'], { cwd: dirB })]);

    const registry = await readRegistry(registryPath);
    expect(Array.isArray(registry)).toBe(true);
    expect(registry).toHaveLength(2);
    expect(registry.some((entry) => entry.path === dirA)).toBe(true);
    expect(registry.some((entry) => entry.path === dirB)).toBe(true);
  });
});

it('leaves the repository working tree exactly as it found it', () => {
  // Runs after every other spec's sandbox has been torn down. Compared
  // against the snapshot taken before the suite started, not against
  // "empty": asserting `git status --porcelain` is empty fails for any
  // developer with uncommitted work already in progress, which is most of
  // the time, and a check that fails for reasons unrelated to its subject
  // is a check that gets ignored. Identical before/after still fails the
  // instant any spec, or the harness itself, writes into the repository
  // rather than into its own sandbox -- the one thing this test exists to
  // catch.
  expect(gitStatus()).toBe(statusBeforeSuite);
});
