#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { buildProgram, exitCodeFor, isCommanderError } from '../program.js';
import { createContext } from '../wiring.js';

async function main(): Promise<number> {
  const context = await createContext(process.env);
  try {
    await buildProgram(context).parseAsync(process.argv);
    return 0;
  } finally {
    context.store.close();
  }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const code = exitCodeFor(error);
    // commander already printed its own message for a usage failure, or
    // its help/version text, through configureOutput above.
    if (!isCommanderError(error)) {
      process.stderr.write(`ailoud: ${messageFor(error)}\n`);
    }
    process.exitCode = code;
  },
);
