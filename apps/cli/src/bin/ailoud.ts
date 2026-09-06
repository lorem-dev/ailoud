#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { styleText } from 'node:util';
import { buildProgram, exitCodeFor, isCommanderError } from '../program.js';
import { createContext } from '../wiring.js';
import { registryPublished, startUpdateCheck } from '../updateNotice.js';
import type { UpdateCheck } from '../updateNotice.js';
import { VERSION } from '../version.js';

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<number> {
  // Started as early as possible -- right after the context exists -- and
  // read only once the command has finished, below. Never awaited here:
  // waiting on the network before the command's own work even starts would
  // add up to `updateTimeoutMs` to every single run of, say, `ailoud ls`.
  let notice: UpdateCheck | null = null;
  let code: number;
  try {
    const context = await createContext(process.env);
    notice = startUpdateCheck({
      fs: context.fs,
      clock: context.clock,
      userDataDir: context.paths.userDataDir,
      currentVersion: VERSION,
      argv: process.argv.slice(2),
      env: process.env,
      stderrIsTTY: process.stderr.isTTY === true,
      checkEnabled: context.config.update.check,
      published: registryPublished(context.updateRegistryHost),
    });
    try {
      await buildProgram(context).parseAsync(process.argv);
      code = 0;
    } finally {
      context.store.close();
    }
  } catch (error) {
    code = exitCodeFor(error);
    // commander already printed its own message for a usage failure, or
    // its help/version text, through configureOutput above.
    if (!isCommanderError(error)) {
      process.stderr.write(`ailoud: ${messageFor(error)}\n`);
    }
  }

  // Same place the process decides its exit code: printed only when the
  // check has already settled (see `UpdateCheck.finish`'s own doc comment).
  // Never printed when the context itself failed to build -- there is no
  // `notice` at all in that case, so nothing to abort or to await.
  if (notice !== null) {
    const target = await notice.finish();
    if (target !== null) {
      // Yellow: this is the one line ailoud prints that the user did not ask
      // for, so it has to be distinguishable at a glance from the output they
      // did. `styleText` is given the stream, so it emits nothing when stderr
      // cannot take colour and it honours NO_COLOR -- belt and braces, since
      // the notice is already suppressed when stderr is not a terminal.
      process.stderr.write(
        styleText(
          'yellow',
          `ailoud: a newer version is available (${VERSION} -> ${target}). Run "ailoud self update" to install it.`,
          { stream: process.stderr },
        ) + '\n',
      );
    }
  }

  return code;
}

main().then((code) => {
  process.exitCode = code;
});
