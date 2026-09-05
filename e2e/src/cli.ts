// The sandbox is the safety property of this suite: every spec runs the
// built binary through here, and nowhere else. `makeSandbox()` is the only
// export that can start the binary, and the process it spawns always gets
// a throwaway HOME, XDG_CONFIG_HOME, and XDG_DATA_HOME. There is no
// exported raw spawn and no way to pass a caller-supplied env that could
// override those three variables -- forgetting any one of them would let a
// spec write into the developer's real library, which is exactly the
// failure this file exists to prevent.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  run(args: readonly string[]): Promise<CliResult>;
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

export async function makeSandbox(): Promise<Sandbox> {
  const home = await mkdtemp(join(tmpdir(), 'ailoud-e2e-'));
  const configHome = join(home, 'config');
  const dataHome = join(home, 'data');
  const configFile = join(configHome, 'ailoud', 'config.yaml');
  const dataDir = join(dataHome, 'ailoud');
  const projectDir = join(home, 'project');
  await mkdir(projectDir, { recursive: true });

  // Every one of these three variables matters: dropping any single one
  // falls back to the real $HOME-derived default in apps/cli/src/config.ts
  // and points the binary at the developer's actual library.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
  };

  return {
    home,
    configFile,
    dataDir,
    projectDir,
    run(args) {
      return runProcess(args, env, projectDir);
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
