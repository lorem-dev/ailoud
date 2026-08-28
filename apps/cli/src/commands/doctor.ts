import { access, constants, stat } from 'node:fs/promises';
import type { Command } from 'commander';
import { EnvironmentError } from '@laud/core';
import { run } from '@laud/providers';
import type { CliContext } from '../wiring.js';
import type { Check } from '../ui/index.js';

export type { Check };

/** Width of the leading "ok"/"FAIL" column, including its trailing padding. */
const STATUS_WIDTH = 6;
/** Width of the check-name column, including its trailing padding. */
const NAME_WIDTH = 22;

/**
 * Turns a list of checks into the printed report and the pass/fail
 * decision. Pure and synchronous: the checks themselves shell out and
 * touch the filesystem, but this part -- the part worth unit-testing
 * without a machine -- does not.
 */
export function renderReport(checks: readonly Check[]): { lines: string[]; ok: boolean } {
  const lines: string[] = [];
  let ok = true;
  for (const check of checks) {
    const status = (check.ok ? 'ok' : 'FAIL').padEnd(STATUS_WIDTH);
    lines.push(`${status}${check.name.padEnd(NAME_WIDTH)}${check.detail}`);
    if (!check.ok) {
      ok = false;
      if (check.fix !== undefined) {
        lines.push(`${' '.repeat(STATUS_WIDTH)}fix: ${check.fix}`);
      }
    }
  }
  return { lines, ok };
}

/**
 * `run()` already turns a missing binary into an `EnvironmentError` whose
 * message points back at "laud doctor" for details -- useful advice from
 * every other caller, but circular when the caller already is doctor. This
 * trims that one case down to the fact that matters here; the `fix` field
 * on the check itself carries the actual remedy.
 */
function summarizeRunFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('was not found on PATH') ? 'not found on PATH' : message;
}

async function checkBinary(
  name: string,
  binary: string,
  args: readonly string[],
  fix: string,
  detailOverride?: string,
): Promise<Check> {
  try {
    const result = await run(binary, args, { timeoutMs: 10_000 });
    if (result.code !== 0) {
      return { name, ok: false, detail: `exited with code ${result.code}`, fix };
    }
    if (detailOverride !== undefined) {
      return { name, ok: true, detail: detailOverride };
    }
    const output = result.stdout.length > 0 ? result.stdout : result.stderr;
    const firstLine = output.split('\n')[0]?.trim() ?? '';
    return { name, ok: true, detail: firstLine };
  } catch (error) {
    return { name, ok: false, detail: summarizeRunFailure(error), fix };
  }
}

async function checkModel(configFile: string, modelPath: string | null): Promise<Check> {
  const name = 'whisper model';
  const fix = `Set "stt.whisperCpp.model" in ${configFile} to the path of a whisper.cpp model file.`;
  if (modelPath === null) {
    return { name, ok: false, detail: 'not configured', fix };
  }
  try {
    await access(modelPath, constants.F_OK);
    return { name, ok: true, detail: modelPath };
  } catch {
    return { name, ok: false, detail: `file not found: ${modelPath}`, fix };
  }
}

/** Absent is `ok`: with no config file, defaults apply and that is normal on a first run. */
async function checkConfigFile(configFile: string): Promise<Check> {
  const name = 'config file';
  try {
    await access(configFile, constants.F_OK);
    return { name, ok: true, detail: configFile };
  } catch {
    return { name, ok: true, detail: `${configFile} (not present; defaults apply)` };
  }
}

function checkDatabase(context: CliContext): Check {
  const { dbFile } = context.paths;
  const version = context.store.schemaVersion();
  const integrity = context.store.integrityCheck();
  const ok = integrity === 'ok';
  const detail = `${dbFile} -- schema version ${version}, integrity_check: ${integrity}`;
  if (ok) return { name: 'database', ok: true, detail };
  return {
    name: 'database',
    ok: false,
    detail,
    fix: `Back up ${dbFile}, then delete it to let laud recreate an empty library.`,
  };
}

async function checkMediaRoot(mediaRoot: string): Promise<Check> {
  const name = 'media root';
  const fix = `Create ${mediaRoot} and make sure laud's user can write to it.`;
  try {
    const info = await stat(mediaRoot);
    if (!info.isDirectory()) {
      return { name, ok: false, detail: `${mediaRoot} exists but is not a directory`, fix };
    }
    await access(mediaRoot, constants.W_OK);
    return { name, ok: true, detail: mediaRoot };
  } catch {
    return { name, ok: false, detail: `${mediaRoot} does not exist or is not writable`, fix };
  }
}

async function runChecks(context: CliContext): Promise<Check[]> {
  const { config, paths } = context;
  return [
    await checkBinary('ffmpeg', 'ffmpeg', ['-version'], 'brew install ffmpeg'),
    await checkBinary('ffprobe', 'ffprobe', ['-version'], 'brew install ffmpeg'),
    // NOT VERIFIED AGAINST A REAL BUILD: this assumes whisper-cli exits 0 on
    // "--help", the same way ffmpeg and ffprobe do on "-version". No
    // whisper-cli binary is available in this environment to confirm that;
    // if a real build exits non-zero for "--help" instead, this check will
    // report a working binary as failing.
    // Reported by the configured value, not by the command's first output
    // line: whisper-cli prints backend chatter ("load_backend: loaded BLAS
    // backend from ...") on stderr and nothing on stdout, for --help and
    // --version alike, so there is no version string to show. The value the
    // user configured is what they need to see anyway.
    await checkBinary(
      'whisper binary',
      config.stt.whisperCpp.binary,
      ['--help'],
      'brew install whisper-cpp',
      config.stt.whisperCpp.binary,
    ),
    await checkModel(paths.configFile, config.stt.whisperCpp.model),
    await checkConfigFile(paths.configFile),
    checkDatabase(context),
    await checkMediaRoot(paths.mediaRoot),
  ];
}

export function registerDoctor(program: Command, context: CliContext): void {
  program
    .command('doctor')
    .description('Check that the binaries, model, database, and storage laud needs are ready')
    .action(async () => {
      await context.ui.frame('doctor', async () => {
        const checks = await runChecks(context);
        context.ui.checks(checks);
        if (checks.some((check) => !check.ok)) {
          throw new EnvironmentError('laud is not ready to run: see the failing checks above.');
        }
      });
    });
}
