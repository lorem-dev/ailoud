import type { Command } from 'commander';
import { FailureError, chooseUpdateTarget } from '@ailoud/core';
import type { CliContext } from '../wiring.js';
import { VERSION } from '../version.js';

/**
 * The only package this project ever asks the registry about. Never
 * `@ailoud/core` or `@ailoud/providers` -- they arrive as this package's own
 * dependencies, so their versions follow whatever `ailoud` itself resolves to.
 */
const PACKAGE_NAME = 'ailoud';

interface SelfCheckOptions {
  readonly json?: boolean;
}

export interface SelfCheckResult {
  readonly current: string;
  readonly target: string | null;
  readonly updatable: boolean;
}

/**
 * The version `ailoud` is running, and the newest one it could move to.
 *
 * Throws a `FailureError` when the lookup itself could not be performed --
 * the registry was unreachable, timed out, or answered with something this
 * build cannot read -- naming the host and the timeout so the message never
 * reads as "you are up to date" when the truth is "this could not be
 * checked". Finding no newer version is not a failure: that is `target ===
 * null` in an ordinary result, because a version check is not a test.
 */
export async function checkForUpdate(context: CliContext): Promise<SelfCheckResult> {
  let published;
  try {
    published = await context.versionSource.published(PACKAGE_NAME);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FailureError(
      `ailoud could not check ${context.updateRegistryHost} for a newer version ` +
        `(timed out after ${context.updateTimeoutMs}ms): ${reason}`,
    );
  }
  const target = chooseUpdateTarget(VERSION, published);
  return { current: VERSION, target, updatable: target !== null };
}

export function registerSelfCheck(parent: Command, context: CliContext): void {
  parent
    .command('check')
    .option('--json', 'print one JSON object instead of text')
    .description('Check whether a newer version of ailoud is published')
    .action(async (options: SelfCheckOptions) => {
      await context.ui.frame('Checking for updates', async () => {
        const result = await checkForUpdate(context);
        if (options.json === true) {
          // Raw, undecorated: a machine reader parses this, the same
          // contract `ls --json` keeps by writing straight through here
          // rather than through the decorated `ui`.
          context.write(JSON.stringify(result));
          return;
        }
        context.write(
          result.target === null
            ? `ailoud ${result.current} is already the newest published version.`
            : `ailoud ${result.current} can update to ${result.target}.`,
        );
      });
    });
}
