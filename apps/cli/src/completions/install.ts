import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { Fs } from '@ailoud/core';
import {
  blockRange as rangeIn,
  hasBlock as hasIn,
  withBlock as withIn,
  withoutBlock as withoutIn,
} from '../markerBlock.js';
import type { CommandNode, Shell } from './generate.js';
import { renderCompletions } from './generate.js';
import type { ShellTarget } from './shells.js';

/**
 * The block ailoud writes into a shell's startup file.
 *
 * A `#` comment in every shell this table covers, so the same pair works for
 * `.bashrc` and `.zshrc` without a second marker syntax to keep in step with
 * `markerBlock.ts`'s pairing rule.
 */
export const START = '# >>> ailoud completions >>>';
export const END = '# <<< ailoud completions <<<';

const MARKERS = { start: START, end: END };

/** Where our block sits, or null. The pairing rule that matters lives in markerBlock.ts. */
export function blockRange(text: string): { readonly from: number; readonly to: number } | null {
  return rangeIn(text, MARKERS);
}

/** Whether a startup file already carries our block. */
export function hasBlock(text: string): boolean {
  return hasIn(text, MARKERS);
}

/** The block body for one shell: the marker pair around the lines that source or register the script. */
function block(target: ShellTarget, scriptPath: string): string {
  return [START, ...target.rcBlockBody(scriptPath), END].join('\n');
}

/** What happened to one file, for the report a command prints. */
export interface FileOutcome {
  readonly path: string;
  readonly action: 'created' | 'updated' | 'unchanged' | 'removed' | 'cleaned' | 'absent';
}

export interface ShellOutcome {
  readonly shell: Shell;
  readonly files: readonly FileOutcome[];
  /** The advisory from `ShellTarget.warnAbout`, or empty when there is none. */
  readonly note: string;
}

/** The directories a script or startup file may need, resolved once by the caller. */
export interface Places {
  readonly home: string;
  readonly configHome: string;
  readonly userDataDir: string;
}

async function readIfPresent(fs: Fs, path: string): Promise<string | null> {
  return (await fs.exists(path)) ? fs.readTextFile(path) : null;
}

async function noteFor(fs: Fs, target: ShellTarget, home: string): Promise<string> {
  if (target.warnAbout === undefined) return '';
  return (await target.warnAbout(fs, home)) ?? '';
}

/**
 * Writes a file without ever leaving it half-written: a temporary file beside
 * it, then a rename over the top.
 *
 * `writeTextFile` truncates before it writes, so a failure part-way through --
 * ENOSPC is the realistic one -- leaves the target EMPTY. The files this
 * writes into are `~/.bashrc` and `~/.zshrc`: files the user hand-edits and
 * that every interactive shell they open reads at startup. Truncating one and
 * then reporting a failure destroys their shell configuration while telling
 * them nothing happened.
 *
 * Same pattern as `write` in `apps/cli/src/mcp/install.ts`, and for the same
 * reason. The temporary name is randomised so two concurrent writers cannot
 * corrupt each other's, and it sits in the target's own directory so the
 * rename stays on one filesystem and therefore stays atomic.
 */
async function write(fs: Fs, path: string, content: string): Promise<void> {
  await fs.ensureDir(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeTextFile(temp, content);
  } catch (error) {
    // The target has not been touched yet, so there is nothing to undo. Clear
    // the partial temporary file rather than leaving litter beside a config.
    await fs.removeFile(temp);
    throw error;
  }
  await fs.rename(temp, path);
}

/**
 * Writes the completion script and, unless the shell needs none, wires it
 * into the startup file.
 *
 * The script and the block are reported separately even though one install
 * writes both: a caller sweeping every shell needs to say which file changed,
 * and collapsing them into one outcome would lose that.
 */
export async function install(
  fs: Fs,
  target: ShellTarget,
  tree: CommandNode,
  places: Places,
): Promise<ShellOutcome> {
  const files: FileOutcome[] = [];

  const scriptPath = target.scriptPath(places.home, places.configHome, places.userDataDir);
  const script = renderCompletions(target.shell, tree);
  const scriptBefore = await readIfPresent(fs, scriptPath);
  if (scriptBefore === null) {
    await write(fs, scriptPath, script);
    files.push({ path: scriptPath, action: 'created' });
  } else if (scriptBefore !== script) {
    await write(fs, scriptPath, script);
    files.push({ path: scriptPath, action: 'updated' });
  } else {
    files.push({ path: scriptPath, action: 'unchanged' });
  }

  const rcPath = target.rcPath(places.home);
  if (rcPath !== null) {
    const rcBefore = await readIfPresent(fs, rcPath);
    const rcAfter = withIn(rcBefore ?? '', block(target, scriptPath), MARKERS);
    if (rcBefore === null) {
      await write(fs, rcPath, rcAfter);
      files.push({ path: rcPath, action: 'created' });
    } else if (rcBefore !== rcAfter) {
      await write(fs, rcPath, rcAfter);
      files.push({ path: rcPath, action: 'updated' });
    } else {
      files.push({ path: rcPath, action: 'unchanged' });
    }
  }

  return { shell: target.shell, files, note: await noteFor(fs, target, places.home) };
}

/**
 * Removes the block from the startup file and deletes the script, leaving
 * anything else in either file untouched.
 *
 * A rc file with no block of ours reports `absent`, not a cleanup it never
 * did -- an uninstall that claims to have cleaned a file it never touched
 * teaches the user to distrust it.
 */
export async function uninstall(
  fs: Fs,
  target: ShellTarget,
  places: Places,
): Promise<ShellOutcome> {
  const files: FileOutcome[] = [];

  const scriptPath = target.scriptPath(places.home, places.configHome, places.userDataDir);
  if (await fs.exists(scriptPath)) {
    await fs.removeFile(scriptPath);
    files.push({ path: scriptPath, action: 'removed' });
  } else {
    files.push({ path: scriptPath, action: 'absent' });
  }

  const rcPath = target.rcPath(places.home);
  if (rcPath !== null) {
    const rcBefore = await readIfPresent(fs, rcPath);
    if (rcBefore === null) {
      files.push({ path: rcPath, action: 'absent' });
    } else {
      const rcAfter = withoutIn(rcBefore, MARKERS);
      if (rcAfter === null) {
        files.push({ path: rcPath, action: 'unchanged' });
      } else {
        // One branch, including when removing our block empties the file: the
        // startup file is written back empty and never deleted. It may have
        // been created empty on purpose -- to override a distro's default --
        // and deleting it is not reversible and was never asked for. This
        // differs from mcp/install.ts deleting an MCP server config it created:
        // that file is a tool's own config, a shell startup file is the user's
        // property. Kept as one arm because the empty case and the rest do
        // exactly the same thing, and two identical arms invite an edit to one
        // that silently misses the other.
        await write(fs, rcPath, rcAfter);
        files.push({ path: rcPath, action: 'cleaned' });
      }
    }
  }

  return { shell: target.shell, files, note: await noteFor(fs, target, places.home) };
}

/**
 * Rewrites what a previous install put in place for this shell, and touches
 * nothing when this shell has nothing installed.
 *
 * Called once per shell in `SHELL_TARGETS` by the caller, not only for the
 * one `$SHELL` currently names: an earlier install may have written into a
 * shell the user has since stopped using, and a stale script left there keeps
 * completing commands that no longer exist. `mcp/install.ts`'s `update` has
 * the same rule, for the same reason, and this function does not look at the
 * environment at all -- it acts on whichever `target` it is given.
 */
export async function refresh(
  fs: Fs,
  target: ShellTarget,
  tree: CommandNode,
  places: Places,
): Promise<ShellOutcome | null> {
  const rcPath = target.rcPath(places.home);

  let configured: boolean;
  if (rcPath === null) {
    // fish has no startup file to carry a block, so the script's own
    // presence is the only signal that it was ever installed.
    const scriptPath = target.scriptPath(places.home, places.configHome, places.userDataDir);
    configured = await fs.exists(scriptPath);
  } else {
    const rcText = await readIfPresent(fs, rcPath);
    configured = rcText !== null && hasIn(rcText, MARKERS);
  }

  if (!configured) return null;
  return install(fs, target, tree, places);
}
