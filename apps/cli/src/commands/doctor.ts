import { access, constants, stat } from 'node:fs/promises';
import type { Command } from 'commander';
import { EnvironmentError, installHint } from '@ailoud/core';
import type { Remedy } from '@ailoud/core';
import { run } from '@ailoud/providers';
import type { CliContext } from '../wiring.js';
import type { Check } from '../ui/index.js';
import type { AiloudConfig } from '../config.js';
import { apiKeyFrom } from '../apiKey.js';
// Imported, not reimplemented: the whole point of this design is that
// `setup` and `doctor --fix` share one provisioning path. Yes, this makes
// doctor.ts and setup.ts mutually import each other (setup.ts imports
// `runChecks` from here) -- safe because both sides only reach the other
// module's export from inside a function body, never at module-init time.
import { blocksReadiness, runProvisioning } from './setup.js';
import type { SetupOptions } from './setup.js';

export type { Check };

/**
 * The one sentence both "not ready" exits use: plain `doctor`, and the
 * provisioning path when everything that failed is un-fixable. Shared so the
 * two cannot drift into reporting the same state differently.
 */
export const NOT_READY_MESSAGE = 'ailoud is not ready to run: see the failing checks above.';

/**
 * `run()` already turns a missing binary into an `EnvironmentError` whose
 * message points back at "ailoud doctor" for details -- useful advice from
 * every other caller, but circular when the caller already is doctor. This
 * trims that one case down to the fact that matters here; the `fix` field
 * on the check itself carries the actual remedy.
 */
function summarizeRunFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('was not found on PATH') ? 'not found on PATH' : message;
}

export async function checkBinary(
  name: string,
  binary: string,
  args: readonly string[],
  fix: string,
  detailOverride?: string,
  remedy?: Remedy,
): Promise<Check> {
  try {
    const result = await run(binary, args, { timeoutMs: 10_000 });
    if (result.code !== 0) {
      return { name, ok: false, detail: `exited with code ${result.code}`, fix, remedy };
    }
    if (detailOverride !== undefined) {
      return { name, ok: true, detail: detailOverride };
    }
    const output = result.stdout.length > 0 ? result.stdout : result.stderr;
    const firstLine = output.split('\n')[0]?.trim() ?? '';
    return { name, ok: true, detail: firstLine };
  } catch (error) {
    return { name, ok: false, detail: summarizeRunFailure(error), fix, remedy };
  }
}

export async function checkModel(
  configFile: string,
  modelPath: string | null,
  remedy?: Remedy,
): Promise<Check> {
  const name = 'whisper model';
  const fix = `Set "stt.whisperCpp.model" in ${configFile} to the path of a whisper.cpp model file.`;
  if (modelPath === null) {
    return { name, ok: false, detail: 'not configured', fix, remedy };
  }
  try {
    await access(modelPath, constants.F_OK);
    return { name, ok: true, detail: modelPath };
  } catch {
    return { name, ok: false, detail: `file not found: ${modelPath}`, fix, remedy };
  }
}

/**
 * Mirrors checkModel, but for the VAD model that --multilingual needs. Kept
 * separate rather than parameterizing checkModel: "not configured" (the key
 * is null) and "missing" (the key names a path with nothing there) are
 * different problems with different fixes, and folding this into checkModel
 * would blur the config key and fix text the message names.
 *
 * `optional: true` throughout: see checkVadBinary's comment on the same
 * flag. --multilingual is opt-in exactly the way --diarize is, so a machine
 * that never transcribes code-switched audio should not carry a permanently
 * failing `doctor` over a feature nobody has asked for.
 */
export async function checkVadModel(
  configFile: string,
  vadModelPath: string | null,
  remedy?: Remedy,
): Promise<Check> {
  const name = 'vad model';
  const fix =
    `Set "stt.whisperCpp.vadModel" in ${configFile} to the path of a whisper VAD model ` +
    'file (e.g. ggml-silero-v5.1.2.bin).';
  if (vadModelPath === null) {
    return { name, ok: false, detail: 'not configured', fix, remedy, optional: true };
  }
  try {
    await access(vadModelPath, constants.F_OK);
    return { name, ok: true, detail: vadModelPath, optional: true };
  } catch {
    return { name, ok: false, detail: `missing: ${vadModelPath}`, fix, remedy, optional: true };
  }
}

/**
 * Checks the VAD segmenter binary. Draws the same distinction checkBinary's
 * caller does for the whisper binary, but made explicit here: a bare
 * command name that is not found on PATH is a different problem, with a
 * different fix, from a configured path that plain does not exist on disk.
 * checkBinary alone cannot tell those apart -- spawn() reports ENOENT for
 * both -- so a configured path (one containing a separator) is checked
 * against the filesystem first.
 *
 * `optional: true` on every branch, mirroring checkDiarizerBinary:
 * --multilingual is opt-in (per transcribe run) exactly the way --diarize
 * is, so this binary being missing means one feature is unavailable, not
 * that ailoud cannot run -- see `Check.optional`'s doc comment. checkBinary
 * itself does not know about `optional` (ffmpeg/whisper share it and stay
 * mandatory, while vad/diarizer share it and are both optional here), so
 * its result is merged with the flag rather than threaded through as a
 * parameter every other caller would have to pass `undefined` for.
 */
export async function checkVadBinary(
  configFile: string,
  vadBinary: string,
  platform: NodeJS.Platform = process.platform,
  remedy?: Remedy,
): Promise<Check> {
  const name = 'vad binary';
  const fix =
    `Set "stt.whisperCpp.vadBinary" in ${configFile} to the path of the ` +
    `whisper-vad-speech-segments binary, or install whisper-cpp (${installHint('whisper', platform)}) ` +
    'so it is on PATH.';
  if (vadBinary.includes('/')) {
    try {
      await access(vadBinary, constants.F_OK);
    } catch {
      return {
        name,
        ok: false,
        detail: `configured path does not exist: ${vadBinary}`,
        fix,
        remedy,
        optional: true,
      };
    }
  }
  const result = await checkBinary(name, vadBinary, ['--help'], fix, vadBinary, remedy);
  return { ...result, optional: true };
}

/**
 * Checks the sherpa-onnx diarizer binary. Mirrors checkVadBinary exactly: a
 * bare command name not found on PATH is a different problem, with a
 * different fix, from a configured path that plain does not exist on disk,
 * and checkBinary alone cannot tell those apart (spawn() reports ENOENT for
 * both).
 *
 * The fix text diverges from checkVadBinary's in one place: it does not
 * claim installing gets the binary "on PATH". installSherpa never puts it
 * there -- unlike whisper.cpp on macOS (brew), sherpa-onnx has no
 * package-manager route on any platform, so ailoud always records an absolute
 * path into config instead (see provisionRunner.ts's install-diarizer
 * branch). Saying "on PATH" here would describe an outcome that never
 * happens.
 *
 * What it does NOT do is name a command alongside the hint. `installHint`
 * already answers "what do I run", per platform, and it deliberately does
 * not answer "ailoud setup" on win32 -- setup refuses to provision Windows,
 * so sending a Windows user there is the circle installHint's own comment
 * warns about. Hardcoding "ailoud setup" here on top of the interpolated hint
 * both re-created that circle and read as a contradiction on every other
 * platform ('run "ailoud setup" (ailoud setup)'). The hint alone, exactly as
 * checkVadBinary uses it.
 *
 * NOT VERIFIED AGAINST A REAL BUILD: like the whisper-cli check above, this
 * assumes sherpa-onnx-offline-speaker-diarization exits 0 on "--help". No
 * such binary is available in this environment to confirm that.
 *
 * `optional: true` on every branch: diarization is opt-in (`--diarize`), so
 * this binary being missing means one feature is unavailable, not that ailoud
 * cannot run -- see `Check.optional`'s doc comment. checkBinary itself does
 * not know about `optional` (ffmpeg/whisper share it and stay mandatory,
 * while vad/diarizer share it and are both optional here), so its result is
 * merged with the flag rather than threaded through as a parameter every
 * other caller would have to pass `undefined` for.
 */
export async function checkDiarizerBinary(
  configFile: string,
  diarizerBinary: string,
  platform: NodeJS.Platform = process.platform,
  remedy?: Remedy,
): Promise<Check> {
  const name = 'diarizer binary';
  const fix =
    `Set "stt.diarization.binary" in ${configFile} to the path of the ` +
    `sherpa-onnx-offline-speaker-diarization binary, or install sherpa-onnx ` +
    `(${installHint('diarizer', platform)}).`;
  if (diarizerBinary.includes('/')) {
    try {
      await access(diarizerBinary, constants.F_OK);
    } catch {
      return {
        name,
        ok: false,
        detail: `configured path does not exist: ${diarizerBinary}`,
        fix,
        remedy,
        optional: true,
      };
    }
  }
  const result = await checkBinary(name, diarizerBinary, ['--help'], fix, diarizerBinary, remedy);
  return { ...result, optional: true };
}

/**
 * Mirrors checkVadModel, but for the pyannote segmentation model diarization
 * needs. Kept separate rather than folded into one parameterized function,
 * for the same reason checkModel and checkVadModel are kept separate: the
 * config key and fix text differ per model, and blurring them together
 * blurs the message a user actually needs to act on.
 *
 * `optional: true` throughout: see checkDiarizerBinary's comment on the
 * same flag. Unlike checkVadModel -- which stays mandatory on purpose, per
 * the follow-up recorded in Check.optional's doc comment -- this one is
 * for a feature nobody has to opt into using at all.
 */
export async function checkSegmentationModel(
  configFile: string,
  segmentationModelPath: string | null,
  remedy?: Remedy,
): Promise<Check> {
  const name = 'diarization segmentation model';
  const fix =
    `Set "stt.diarization.segmentationModel" in ${configFile} to the path of the sherpa-onnx ` +
    'pyannote segmentation model file (model.onnx from the sherpa-onnx-pyannote-segmentation-3-0 release).';
  if (segmentationModelPath === null) {
    return { name, ok: false, detail: 'not configured', fix, remedy, optional: true };
  }
  try {
    await access(segmentationModelPath, constants.F_OK);
    return { name, ok: true, detail: segmentationModelPath, optional: true };
  } catch {
    return {
      name,
      ok: false,
      detail: `missing: ${segmentationModelPath}`,
      fix,
      remedy,
      optional: true,
    };
  }
}

/** Mirrors checkSegmentationModel, for the speaker-embedding model. */
export async function checkEmbeddingModel(
  configFile: string,
  embeddingModelPath: string | null,
  remedy?: Remedy,
): Promise<Check> {
  const name = 'diarization embedding model';
  const fix =
    `Set "stt.diarization.embeddingModel" in ${configFile} to the path of the sherpa-onnx ` +
    'speaker embedding model file (3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx).';
  if (embeddingModelPath === null) {
    return { name, ok: false, detail: 'not configured', fix, remedy, optional: true };
  }
  try {
    await access(embeddingModelPath, constants.F_OK);
    return { name, ok: true, detail: embeddingModelPath, optional: true };
  } catch {
    return {
      name,
      ok: false,
      detail: `missing: ${embeddingModelPath}`,
      fix,
      remedy,
      optional: true,
    };
  }
}

/**
 * The language model, whichever kind is configured.
 *
 * One check rather than four, because a user has exactly one provider
 * selected and the other three are none of their business. What "configured"
 * means differs completely between them -- a file on disk, a key in the
 * environment, a signed-in CLI -- so this dispatches rather than pretending
 * they are the same shape.
 *
 * `optional: true` throughout, like the diarization checks above: `summarize`
 * is opt-in, and someone who only transcribes should not carry a red
 * `doctor` for a feature they have never used.
 */
export async function checkLanguageModel(
  configFile: string,
  llm: AiloudConfig['llm'],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<Check> {
  const name = 'language model';

  if (llm.provider === 'claude-cli') {
    const fix =
      `Install Claude Code and sign in, or set "llm.provider" in ${configFile} to another ` +
      'provider.';
    // Only that the binary runs. Whether the subscription is signed in is not
    // knowable without making a billable request, and doctor does not spend
    // the user's money to answer a question.
    const result = await checkBinary(name, llm.claudeCli.binary, ['--version'], fix, undefined, {
      kind: 'install-llm',
    });
    return {
      ...result,
      ...(result.ok
        ? { detail: `${llm.claudeCli.binary} (${llm.claudeCli.model}, via subscription)` }
        : {}),
      optional: true,
    };
  }

  if (llm.provider === 'anthropic' || llm.provider === 'openai-compatible') {
    const variable = llm.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    const key = apiKeyFrom(env, variable);
    const settings = llm.provider === 'anthropic' ? llm.anthropic : llm.openaiCompatible;
    // A local OpenAI-compatible server needs no key, so its absence is only a
    // problem when the endpoint is a hosted one.
    const hosted = /api\.(openai|anthropic)\.com/.test(settings.baseUrl);
    if (key === undefined && hosted) {
      return {
        name,
        ok: false,
        detail: `${settings.model} at ${settings.baseUrl}, no API key`,
        fix: `Set AILOUD_LLM_API_KEY or ${variable} in your environment. Keys are read from the environment, never from ${configFile}.`,
        optional: true,
      };
    }
    return {
      name,
      ok: true,
      detail: `${settings.model} at ${settings.baseUrl}${key === undefined ? '' : ', key set'}`,
      optional: true,
    };
  }

  const settings = llm.llamaCpp;
  if (settings.model === null) {
    return {
      name,
      ok: false,
      detail: 'not configured',
      fix:
        `Run "ailoud setup" to install a local model, or set "llm.llamaCpp.model" in ${configFile} ` +
        `to a GGUF file. ${installHint('llm', platform)} installs the runner.`,
      remedy: { kind: 'download-llm-model' },
      optional: true,
    };
  }
  try {
    await access(settings.model, constants.F_OK);
  } catch {
    return {
      name,
      ok: false,
      detail: `missing: ${settings.model}`,
      fix: `Run "ailoud setup", or point "llm.llamaCpp.model" in ${configFile} at a GGUF file that exists.`,
      remedy: { kind: 'download-llm-model' },
      optional: true,
    };
  }
  return { name, ok: true, detail: settings.model, optional: true };
}

/**
 * The local runner, when a local runner is what is configured.
 *
 * Separate from the model check rather than folded into it, the same way the
 * whisper binary and the whisper model are separate: a check carries one
 * remedy, and one check for both meant `setup` downloaded two gigabytes of
 * GGUF and left no `llama-cli` to run it -- without ever naming the install
 * on the consent screen.
 */
export async function checkLanguageRunner(
  configFile: string,
  binary: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Check> {
  const result = await checkBinary(
    'language runner',
    binary,
    ['--version'],
    `${installHint('llm', platform)}, or set "llm.llamaCpp.binary" in ${configFile} to a ` +
      'llama-cli built from source.',
    undefined,
    { kind: 'install-llm' },
  );
  return { ...result, optional: true };
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
    fix: `Back up ${dbFile}, then delete it to let ailoud recreate an empty library.`,
  };
}

async function checkMediaRoot(mediaRoot: string, remedy?: Remedy): Promise<Check> {
  const name = 'media root';
  const fix = `Create ${mediaRoot} and make sure ailoud's user can write to it.`;
  try {
    const info = await stat(mediaRoot);
    if (!info.isDirectory()) {
      return { name, ok: false, detail: `${mediaRoot} exists but is not a directory`, fix, remedy };
    }
    await access(mediaRoot, constants.W_OK);
    return { name, ok: true, detail: mediaRoot };
  } catch {
    return {
      name,
      ok: false,
      detail: `${mediaRoot} does not exist or is not writable`,
      fix,
      remedy,
    };
  }
}

/**
 * `platform` defaults to `process.platform` so callers never have to think
 * about it, and is a parameter (rather than read directly from
 * `process.platform` inline) so tests can pin the fix text a check reports
 * without mocking the process global.
 */
export async function runChecks(
  context: CliContext,
  platform: NodeJS.Platform = process.platform,
  // Injected rather than read from the global, so a test can pin what the
  // key check sees without touching the real environment.
  env: NodeJS.ProcessEnv = process.env,
): Promise<Check[]> {
  const { config, paths } = context;
  return [
    await checkBinary(
      'ffmpeg',
      'ffmpeg',
      ['-version'],
      installHint('ffmpeg', platform),
      undefined,
      { kind: 'install-ffmpeg' },
    ),
    await checkBinary(
      'ffprobe',
      'ffprobe',
      ['-version'],
      installHint('ffmpeg', platform),
      undefined,
      { kind: 'install-ffmpeg' },
    ),
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
      installHint('whisper', platform),
      config.stt.whisperCpp.binary,
      { kind: 'install-whisper' },
    ),
    await checkModel(paths.configFile, config.stt.whisperCpp.model, {
      kind: 'download-model',
      slot: 'transcription',
    }),
    // Binary before model for both whisper and VAD, matching the order
    // README.md documents: keeping the two pairs in the same shape stops
    // the code and the docs from silently drifting onto different orders.
    await checkVadBinary(paths.configFile, config.stt.whisperCpp.vadBinary, platform, {
      kind: 'install-whisper',
    }),
    await checkVadModel(paths.configFile, config.stt.whisperCpp.vadModel, {
      kind: 'download-model',
      slot: 'vad',
    }),
    // Same binary-before-model shape as the whisper/VAD pair above, and run
    // unconditionally too, so `setup`/`doctor --fix` can offer to provision
    // the diarizer before anyone has passed --diarize -- but each of the
    // three below is `optional: true` (see Check.optional): --diarize is
    // opt-in, so not having set it up yet is not the same problem as a
    // missing ffmpeg, and must not make plain `doctor` report "not ready".
    await checkDiarizerBinary(paths.configFile, config.stt.diarization.binary, platform, {
      kind: 'install-diarizer',
    }),
    await checkSegmentationModel(paths.configFile, config.stt.diarization.segmentationModel, {
      kind: 'download-diarization-model',
      slot: 'segmentation',
    }),
    await checkEmbeddingModel(paths.configFile, config.stt.diarization.embeddingModel, {
      kind: 'download-diarization-model',
      slot: 'embedding',
    }),
    // Only for the local provider: a "language runner" line reading "not used
    // by this provider" is noise on a machine that talks to a hosted API.
    ...(config.llm.provider === 'llama-cpp'
      ? [await checkLanguageRunner(paths.configFile, config.llm.llamaCpp.binary, platform)]
      : []),
    await checkLanguageModel(paths.configFile, config.llm, env, platform),
    await checkConfigFile(paths.configFile),
    checkDatabase(context),
    await checkMediaRoot(paths.mediaRoot, { kind: 'create-directory', path: paths.mediaRoot }),
  ];
}

export interface DoctorOptions extends SetupOptions {
  readonly fix?: boolean;
}

/**
 * `platform` defaults to `process.platform`, the same reason `runChecks`
 * and `registerSetup` take one: it lets the Windows refusal below (inherited
 * from `runProvisioning`, the shared engine) be tested without a Windows box.
 */
export function registerDoctor(
  program: Command,
  context: CliContext,
  platform: NodeJS.Platform = process.platform,
): void {
  program
    .command('doctor')
    .option('--fix', 'provision anything that failed a check, using the same engine as setup')
    .option('--yes', 'confirm the fix plan without prompting')
    .option('--model <name>', 'transcription model to download if one is needed (default: small)')
    .option('--llm <choice>', 'summariser to set up: local, claude-cli, claude-api, openai, skip')
    .option(
      '--llm-model <id>',
      'model id for the chosen summariser (default: ask, or keep the configured one)',
    )
    .description('Check that the binaries, model, database, and storage ailoud needs are ready')
    .action(async (options: DoctorOptions) => {
      await context.ui.frame('Environment check', async () => {
        const checks = await runChecks(context, platform);
        context.ui.checks(checks);
        if (options.fix !== true) {
          if (checks.some(blocksReadiness)) {
            throw new EnvironmentError(NOT_READY_MESSAGE);
          }
          return;
        }
        // The whole check list, not a pre-filtered remedy list:
        // runProvisioning owns the "which of these are auto-fixable"
        // decision (collectRemedies), so --fix still acts only on what
        // actually failed while keeping "nothing failed" distinguishable
        // from "nothing fixable failed".
        //
        // 'doctor', explicitly: runProvisioning's messages (the consent
        // guard, a cancelled model prompt, the Windows refusal) must name
        // the command the user actually typed, not default to the other
        // caller's name.
        //
        // checksAlreadyShown: true -- ui.checks(checks) just above already
        // rendered every failing check's name, detail, and fix text; without
        // this, runProvisioning's own unfixable-checks report would print
        // the identical list a second time.
        await runProvisioning(context, options, checks, platform, 'doctor', true);
      });
    });
}
