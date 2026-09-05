import { dirname, join } from 'node:path';
import type { RunResult } from '../process/run.js';

/**
 * `hint` is the command to run by hand, and every refusing variant carries
 * one: a refusal that does not say what to do instead is just a failure.
 */
export type InstallMethod =
  | { readonly kind: 'npm-global' }
  | { readonly kind: 'pnpm-global' }
  | { readonly kind: 'npx'; readonly hint: string }
  | { readonly kind: 'project'; readonly projectDir: string; readonly hint: string }
  | { readonly kind: 'unknown'; readonly hint: string };

export interface DetectOptions {
  /**
   * The Node binary running this process, i.e. `process.execPath`.
   *
   * Used to locate the global `node_modules` of the Node that is RUNNING us,
   * which is the one ailoud was installed into. `npm root -g` cannot answer
   * that on its own: under nvm, fnm, asdf and volta the npm on PATH often
   * belongs to a different Node version, so it reports that version's root,
   * our own root never matches it, and an ordinary global install is then
   * misread as a project dependency -- with a hint telling the user to run an
   * add command inside `~/.nvm/versions/node/v18.20.4/lib`.
   */
  readonly execPath: string;
  /** Where the installed package sits, resolved from `import.meta.url`. */
  readonly packageRoot: string;
  readonly realpath: (path: string) => Promise<string>;
  readonly run: (command: string, args: readonly string[]) => Promise<RunResult>;
}

export async function detectInstallMethod(options: DetectOptions): Promise<InstallMethod> {
  const root = await options.realpath(options.packageRoot);

  // FIRST. An npx cache entry also sits inside a `node_modules`, so a
  // node_modules check placed ahead of this one reports it as a project
  // dependency and prints the wrong command.
  if (root.includes('/_npx/')) return { kind: 'npx', hint: 'npx ailoud@<version>' };

  // Both managers, in parallel, each tolerating "not installed". `npm root -g`
  // and `pnpm root -g` print the global node_modules.
  const [npmRoot, pnpmRoot] = await Promise.all([
    globalRoot(options, 'npm'),
    globalRoot(options, 'pnpm'),
  ]);
  if (npmRoot !== null && isUnder(root, npmRoot)) return { kind: 'npm-global' };
  if (pnpmRoot !== null && isUnder(root, pnpmRoot)) return { kind: 'pnpm-global' };

  // The global root of the Node running us, checked after the managers and

  // before the project fallback: it is the layout npm itself uses

  // (`<prefix>/lib/node_modules`), and it is version-correct by

  // construction because it comes from our own interpreter.

  const ownRoot = await options
    .realpath(`${dirname(dirname(options.execPath))}/lib/node_modules`)
    .catch(() => null);

  if (ownRoot !== null && isUnder(root, ownRoot)) return { kind: 'npm-global' };

  // Whatever is left inside a node_modules is somebody's dependency. The
  // FIRST `/node_modules/` is the project boundary, not the last: pnpm installs
  // a project dependency at
  // `<project>/node_modules/.pnpm/ailoud@1.0.0/node_modules/ailoud`, so taking
  // the last one named the store entry and told the user to run their add
  // command in `.../node_modules/.pnpm/ailoud@1.0.0`. A nested dependency of a
  // dependency lands on the project for the same reason, which is also right.
  const marker = root.indexOf('/node_modules/');
  if (marker !== -1) {
    const projectDir = root.slice(0, marker);
    return {
      kind: 'project',
      projectDir,
      hint: `run your package manager's add command in ${projectDir}`,
    };
  }
  return {
    kind: 'unknown',
    hint: 'npm install -g ailoud@<version>, or pnpm add -g ailoud@<version>',
  };
}

async function globalRoot(options: DetectOptions, manager: string): Promise<string | null> {
  try {
    const result = await options.run(manager, ['root', '-g']);
    if (result.code !== 0) return null;
    // realpath both sides: pnpm's global tree is a symlink farm, and an
    // unresolved string compare misses every time.
    return await options.realpath(result.stdout.trim());
  } catch {
    return null; // that manager is not on this machine
  }
}

/**
 * The argv for an update, or null when this install method cannot be updated.
 *
 * `npm-global` is anchored to `join(dirname(execPath), 'npm')` rather than
 * bare `'npm'`: every npm global install lays its bins out beside `node`
 * itself, so this is the one npm that is GUARANTEED to belong to the Node
 * that is running us, unlike a bare name, which PATH resolves and which can
 * belong to an entirely different Node under nvm/fnm/asdf/volta (see
 * `DetectOptions.execPath`'s own doc comment, and `self.ts`'s doc comment on
 * `updateSelf`, for the concrete machine layout that breaks under a bare
 * name).
 *
 * `pnpm-global` deliberately stays bare `'pnpm'`: pnpm's global bin comes
 * from `PNPM_HOME`/corepack, not from any one Node's install tree, so there
 * is no execPath-equivalent anchor for it, and bare `pnpm` IS the correct
 * resolution here. Do not "fix" this into an anchored path -- there is
 * nothing to anchor it to.
 */
export function installCommandFor(
  method: InstallMethod,
  target: string,
  execPath: string,
): readonly string[] | null {
  switch (method.kind) {
    case 'npm-global':
      return [join(dirname(execPath), 'npm'), 'install', '-g', `ailoud@${target}`];
    case 'pnpm-global':
      return ['pnpm', 'add', '-g', `ailoud@${target}`];
    case 'npx':
    case 'project':
    case 'unknown':
      return null;
  }
}

/**
 * The argv for the subprocess that re-syncs rules after a successful
 * install, or null when it cannot be determined -- the caller then prints
 * the command for the user to run by hand rather than guessing.
 *
 * Anchored the same way `installCommandFor` anchors the install itself, and
 * for the same reason: a bare `ailoud` resolved off PATH can be an entirely
 * different install than the one the package manager just wrote.
 *
 * `npm-global`: the new binary sits beside `npm` and `node` in the same bin
 * directory by construction, so `dirname(execPath)` anchors it exactly like
 * the install command above.
 *
 * `pnpm-global`: there is no execPath-equivalent anchor, so this asks pnpm
 * itself where its global bin lives (`pnpm bin -g`), through the same `run`
 * detection uses -- bounded to the same 10 second timeout in production
 * (`boundedDetectRun` in `self.ts`). Null when that query fails or answers
 * nothing, rather than guessing at a bare `ailoud`.
 */
export async function sweepCommandFor(
  method: InstallMethod,
  execPath: string,
  run: (command: string, args: readonly string[]) => Promise<RunResult>,
): Promise<readonly string[] | null> {
  switch (method.kind) {
    case 'npm-global':
      return [join(dirname(execPath), 'ailoud'), 'self', 'sync'];
    case 'pnpm-global': {
      const bin = await pnpmGlobalBin(run);
      return bin === null ? null : [join(bin, 'ailoud'), 'self', 'sync'];
    }
    case 'npx':
    case 'project':
    case 'unknown':
      return null;
  }
}

async function pnpmGlobalBin(
  run: (command: string, args: readonly string[]) => Promise<RunResult>,
): Promise<string | null> {
  try {
    const result = await run('pnpm', ['bin', '-g']);
    if (result.code !== 0) return null;
    const bin = result.stdout.trim();
    return bin === '' ? null : bin;
  } catch {
    return null;
  }
}

/**
 * Whether `path` sits inside `directory`.
 *
 * The separator is required, so `/usr/lib/node_modules-other/ailoud` does not
 * read as living under `/usr/lib/node_modules`. A bare `startsWith` compares
 * characters, not path components.
 */
function isUnder(path: string, directory: string): boolean {
  const base = directory.endsWith('/') ? directory : `${directory}/`;
  return path.startsWith(base);
}
