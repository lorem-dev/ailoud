import { Command } from 'commander';
import { AiloudError } from '@ailoud/core';
import { registerDoctor } from './commands/doctor.js';
import { registerImport } from './commands/import.js';
import { registerLs } from './commands/ls.js';
import { registerSetup } from './commands/setup.js';
import { registerShow } from './commands/show.js';
import { registerRm } from './commands/rm.js';
import { registerAnnotate } from './commands/annotate.js';
import { registerSummarize } from './commands/summarize.js';
import { registerReports } from './commands/reports.js';
import { registerTemplate } from './commands/template.js';
import { registerSearch } from './commands/search.js';
import { registerMcp } from './commands/mcp.js';
import { attachLetters, group, inGroupAndTopLevel } from './commands/groups.js';
import { registerTranscribe } from './commands/transcribe.js';
import type { CliContext } from './wiring.js';

/**
 * Reads the commander error code off an unknown thrown value without
 * assuming it is an object. A thrown string, `null`, or `undefined` must
 * fall through cleanly instead of crashing the handler whose entire job is
 * to turn a failure into a clean exit code.
 */
function commanderCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  if (!('code' in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' && code.startsWith('commander.') ? code : null;
}

/** True for any error commander itself raised via `.exitOverride()`. */
export function isCommanderError(error: unknown): boolean {
  return commanderCodeOf(error) !== null;
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof AiloudError) return error.exitCode;
  // Do not key off the code string: `commander.help` is not uniformly a
  // clean exit -- commander uses that same code both for `--help` (its own
  // exitCode is 0) and for running `ailoud` with no subcommand once one is
  // registered (its own exitCode is 1, because that is a usage error of the
  // same class as a missing argument). Trusting the code string over the
  // error's own `exitCode` would let that second case leak through as 1
  // instead of this project's 2. The error's own exitCode is authoritative
  // for "was this a clean exit" (0) versus "was this a usage mistake" (any
  // other commander exit code, remapped to 2 per this project's convention).
  if (commanderCodeOf(error) !== null) {
    const exitCode = (error as { exitCode?: unknown }).exitCode;
    return exitCode === 0 ? 0 : 2;
  }
  return 1;
}

export function buildProgram(context: CliContext): Command {
  const program = new Command();
  program
    .name('ailoud')
    .description('Multilingual audio-to-text with a local recording library')
    .version('0.0.0')
    .exitOverride(); // throw instead of calling process.exit
  // Commander's own help/version text stays plain in both modes: routed
  // through context.write, not context.ui, so it is never decorated.
  program.configureOutput({
    writeOut: (str) => context.write(str.replace(/\n$/, '')),
    writeErr: (str) => process.stderr.write(str),
  });
  // Verbs that bring something into being stay at the top level; everything
  // that inspects or removes what already exists lives under the noun it acts
  // on. That is the shape `docker` and `gh` settled on, and it is what keeps
  // `ailoud --help` readable as the library grows.
  const audio = group(program, 'audio', 'recordings', 'Work with recordings in the library');
  for (const register of [
    registerImport,
    registerTranscribe,
    registerSummarize,
    registerSearch,
    registerLs,
    registerShow,
    registerAnnotate,
    registerRm,
  ]) {
    inGroupAndTopLevel(program, audio, register, context);
  }
  attachLetters(audio);

  const report = group(program, 'report', 'reports', 'Work with saved summaries');
  registerReports(report, context);
  attachLetters(report);

  const template = group(
    program,
    'template',
    'templates',
    'Summary templates -- what shape a summary of this kind of conversation takes',
  );
  registerTemplate(template, context);
  attachLetters(template);

  registerMcp(program, context);
  registerDoctor(program, context);
  registerSetup(program, context);
  return program;
}
