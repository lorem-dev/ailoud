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
  if (npmRoot !== null && root.startsWith(npmRoot)) return { kind: 'npm-global' };
  if (pnpmRoot !== null && root.startsWith(pnpmRoot)) return { kind: 'pnpm-global' };

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

/** The argv for an update, or null when this install method cannot be updated. */
export function installCommandFor(method: InstallMethod, target: string): readonly string[] | null {
  switch (method.kind) {
    case 'npm-global':
      return ['npm', 'install', '-g', `ailoud@${target}`];
    case 'pnpm-global':
      return ['pnpm', 'add', '-g', `ailoud@${target}`];
    case 'npx':
    case 'project':
    case 'unknown':
      return null;
  }
}
