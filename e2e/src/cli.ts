// The sandbox is the safety property of this suite: every spec runs the
// built binary through here, and nowhere else. `makeSandbox()` is the only
// export that can start the binary, and the process it spawns always gets
// a throwaway HOME, XDG_CONFIG_HOME, and XDG_DATA_HOME. There is no
// exported raw spawn, and `run`'s own `env` option cannot override those
// three variables no matter what a caller passes -- forgetting any one of
// them would let a spec write into the developer's real library, which is
// exactly the failure this file exists to prevent.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** The binary this suite drives: the built CLI, never the TypeScript source. */
const BINARY = join(__dirname, '..', '..', 'apps', 'cli', 'dist', 'bin', 'ailoud.js');

/** whisper.cpp on CPU is slow; a hung process should still not hang the suite forever. */
const RUN_TIMEOUT_MS = 300_000;

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  /**
   * Extra variables for this one call, layered UNDER the sandbox's own
   * HOME/XDG_CONFIG_HOME/XDG_DATA_HOME -- those three always win, even if a
   * caller names them here. What this is for: threading `AILOUD_PACKUMENTS`
   * (a JSON fixture path, never a server -- see `packumentFixture` in
   * `self-update.spec.ts`) or a stub-tool directory prepended to `PATH`.
   */
  readonly env?: Record<string, string>;
  /**
   * Overrides the child's cwd for this one call, still somewhere under the
   * sandbox. Defaults to `projectDir`. Load-bearing for the specs that
   * register more than one project directory in the same sandbox: `self
   * sync` sweeps `projects.json`, whose entries are real paths, so testing a
   * pruned or a concurrently-registered project needs more than one such
   * path to exist.
   */
  readonly cwd?: string;
}

export interface Sandbox {
  /** The sandboxed $HOME. Nothing outside it should ever be touched. */
  readonly home: string;
  /** Where ailoud looks for config.yaml, per apps/cli/src/config.ts. */
  readonly configFile: string;
  /** Where ailoud stores its database and media, per apps/cli/src/config.ts. */
  readonly dataDir: string;
  /**
   * A working directory inside the sandbox, used as the child's cwd.
   *
   * Load-bearing for anything that writes relative to where it was run --
   * `mcp install --location local` writes `.mcp.json` and a rules block into
   * the current directory, and without this the child would inherit the
   * repository as its cwd and edit the real files.
   */
  readonly projectDir: string;
  /** Runs the built binary with this sandbox's environment. The only way a spec invokes it. */
  run(args: readonly string[], options?: RunOptions): Promise<CliResult>;
  /** Writes config.yaml inside the sandbox, creating its parent directory. */
  writeConfig(yaml: string): Promise<void>;
  /** Removes the sandbox directory. Call once the test is done with it. */
  cleanup(): Promise<void>;
}

function runProcess(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BINARY, ...args], {
      env,
      cwd,
      timeout: RUN_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * The parent's own environment, minus the variables that have bitten this
 * project's tests before: every `GITHUB_` variable (CI sets several that
 * change script behaviour -- see `scripts/testing/harness.mjs`) and
 * `AILOUD_NO_UPDATE_CHECK`, so a spec's outcome never depends on whatever
 * happened to be exported in the shell -- or the CI job -- that ran it.
 */
function scrubbedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GITHUB_') && key !== 'AILOUD_NO_UPDATE_CHECK',
    ),
  );
}

export async function makeSandbox(): Promise<Sandbox> {
  // Resolved through realpath immediately: on macOS, os.tmpdir() answers
  // under /var/folders, but the OS reports a spawned child's own cwd already
  // canonicalised to /private/var/folders -- the same directory, a
  // different string. Left unresolved here, `sandbox.projectDir` would not
  // byte-for-byte equal a path the CLI itself prints or records (a project
  // registry entry, `self sync`'s own report), while a bare `toContain()`
  // check could still pass by accident: the unresolved form is a plain
  // substring of the canonical one. Resolving once, here, is what makes
  // every path this sandbox hands out compare equal to what the binary
  // actually sees.
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ailoud-e2e-')));
  const configHome = join(home, 'config');
  const dataHome = join(home, 'data');
  const configFile = join(configHome, 'ailoud', 'config.yaml');
  const dataDir = join(dataHome, 'ailoud');
  const projectDir = join(home, 'project');
  await mkdir(projectDir, { recursive: true });

  const base = scrubbedEnv();

  return {
    home,
    configFile,
    dataDir,
    projectDir,
    run(args, options) {
      // Every one of these three matters: dropping any single one falls back
      // to the real $HOME-derived default in apps/cli/src/config.ts and
      // points the binary at the developer's actual library. Applied LAST,
      // after any caller-supplied `options.env`, so nothing above can shadow
      // them.
      const env: NodeJS.ProcessEnv = {
        ...base,
        ...options?.env,
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
      };
      return runProcess(args, env, options?.cwd ?? projectDir);
    },
    async writeConfig(yaml) {
      await mkdir(dirname(configFile), { recursive: true });
      await writeFile(configFile, yaml, 'utf8');
    },
    async cleanup() {
      await rm(home, { recursive: true, force: true });
    },
  };
}
