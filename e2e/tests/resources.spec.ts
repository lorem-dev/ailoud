// End-to-end coverage of the resource-budget and denoise flags:
// `--max-cpu`, `--no-gpu` and `--denoise`, and what `doctor` reports about
// the machine they act on.
//
// This file is split across BOTH jest projects (see jest.config.cjs): the
// `describe` block below drives the built binary entirely through stub
// binaries on PATH (see writeStub) and never spawns a real engine, so it
// belongs to `no-tools`, which runs on every push. A second `describe`
// block, appended by a later change, drives real ffmpeg/whisper-cli/a model
// and belongs to `tools` alone -- guarded by AILOUD_E2E_TOOLS, which
// setupNoTools.cjs/setupTools.cjs set per project, since Jest's testMatch
// can only assign a whole FILE to a project, not one describe block within
// it shared by two.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Sandbox } from '../src/cli';
import { installedWhisperModel } from '../src/models';
import { makeSandbox } from '../src/cli';
import { wordErrorRate } from '../src/wer';

const REPO_ROOT = join(__dirname, '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');
const EN_WAV = join(FIXTURES_DIR, 'en-short.wav');

/**
 * A deliberate COPY of two pure functions this spec needs to compute its own
 * expectations the same way the code does: `resourceBudget` from
 * packages/core/src/resources/budget.ts, and the darwin branch of
 * `cpuTopology` from packages/providers/src/system/cpuTopology.ts.
 *
 * Not an import, for the same reason jobs.spec.ts's `isProcessAlive` is a
 * copy rather than one (see that file's own comment): `@ailoud/core` and
 * `@ailoud/providers` are ESM-only workspace packages that are not linked
 * into the repository root's node_modules -- only apps/cli and
 * packages/providers declare them as dependencies -- and this suite runs
 * under e2e/tsconfig.json's CommonJS. Reaching them would need either a
 * build-output import (this suite drives the CLI as a subprocess precisely
 * to test the built artifact, not its internals) or a second tsconfig
 * project reference for a few lines of pure arithmetic. Kept intentionally
 * small and pinned to both files by name in this comment, not reinvented.
 */
interface LocalCpuTopology {
  readonly logical: number;
  readonly performance: number | null;
}

interface LocalResourceBudget {
  readonly threads: number;
  readonly cappedThreads: number;
}

const CAPPED_MAX_THREADS = 6;
const DEFAULT_MAX_CPU_PERCENT = 90;

function localCpuTopology(): LocalCpuTopology {
  const logical = Math.max(1, Math.round(availableParallelism()));
  if (process.platform !== 'darwin') return { logical, performance: null };
  try {
    const stdout = execFileSync('sysctl', ['-n', 'hw.perflevel0.logicalcpu'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const trimmed = stdout.trim();
    const value = Number(trimmed);
    if (trimmed === '' || !Number.isInteger(value) || value < 1 || value > logical) {
      return { logical, performance: null };
    }
    return { logical, performance: value };
  } catch {
    return { logical, performance: null };
  }
}

function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

function localResourceBudget(
  topology: LocalCpuTopology,
  options: { readonly maxCpuPercent?: number } = {},
): LocalResourceBudget {
  const requested = options.maxCpuPercent;
  const percent =
    requested !== undefined && Number.isFinite(requested) && requested >= 1 && requested <= 100
      ? requested
      : DEFAULT_MAX_CPU_PERCENT;
  const base = Math.max(1, Math.round(topology.performance ?? topology.logical));
  const threads = clamp(Math.round((base * percent) / 100), 1, base);
  const cappedThreads = Math.min(threads, CAPPED_MAX_THREADS);
  return { threads, cappedThreads };
}

/** Parses an `import` output line: "<id>  imported|already present  <path>". */
function parseImportLine(line: string): { id: string; status: string; path: string } {
  const match = /^(\S+)\s+(imported|already present)\s+(.+)$/.exec(line);
  if (match === null) throw new Error(`unexpected import output: ${JSON.stringify(line)}`);
  return { id: match[1]!, status: match[2]!, path: match[3]! };
}

/** Parse the job id from `transcribe --detach` output: "started job <id> -- ...". */
function parseDetachId(output: string): string {
  const match = /started job (\S+)/.exec(output);
  if (match === null) throw new Error(`invalid --detach output: ${JSON.stringify(output)}`);
  return match[1]!;
}

interface JobState {
  readonly state: 'running' | 'done' | 'failed';
}

/** Reads the job state file from the sandbox's data directory, or null before it exists. */
async function readJobState(sandbox: Sandbox, jobId: string): Promise<JobState | null> {
  const statePath = join(sandbox.dataDir, 'jobs', `${jobId}.json`);
  try {
    return JSON.parse(await readFile(statePath, 'utf8')) as JobState;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls the job state file until it reaches a terminal state, or the deadline passes. */
async function waitForTerminal(sandbox: Sandbox, jobId: string): Promise<JobState> {
  const deadline = Date.now() + 60_000;
  let state = await readJobState(sandbox, jobId);
  while ((state === null || state.state === 'running') && Date.now() < deadline) {
    await delay(200);
    state = await readJobState(sandbox, jobId);
  }
  if (state === null) throw new Error(`job ${jobId} never wrote a state file`);
  return state;
}

/**
 * A fake engine binary that appends its argv to a file and produces the
 * minimum output the adapter parses. This is how argv is asserted without a
 * real whisper, which is what keeps this spec in the no-tools project.
 */
async function writeStub(
  dir: string,
  name: string,
  body: string,
): Promise<{ readonly path: string; argv(): Promise<string[][]> }> {
  const path = join(dir, name);
  const log = join(dir, `${name}.argv`);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n${body}\n`, {
    mode: 0o755,
  });
  return {
    path,
    async argv() {
      const raw = await readFile(log, 'utf8').catch(() => '');
      return raw
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.split(' '));
    },
  };
}

// Every body below answers `--help` first: `doctor` probes every configured
// binary with it (checkBinary, probeBackends), and without this branch the
// stub would fall into its normal logic and either write a bogus output file
// or produce output the doctor-facing parsers do not expect.

/**
 * Derived from packages/providers/src/stt/whisperCpp.ts's parsers: writes
 * `<outputBase>.json` in the shape `parseWhisperJson` expects (one
 * non-blank segment), answers `-dl` the way `parseDetectedLanguage` expects,
 * and answers `--help` the way `parseBackends` expects (a `load_backend:
 * loaded <NAME> backend` line), reporting `CPU` so `doctor` prints the
 * CPU-only setup note rather than inventing a GPU backend this stub does
 * not have.
 */
const WHISPER_BODY = `
case " $* " in
  *" --help "*)
    echo "load_backend: loaded CPU backend from stub" 1>&2
    exit 0
    ;;
esac
case " $* " in
  *" -dl "*)
    echo "auto-detected language: en" 1>&2
    exit 0
    ;;
esac
outbase=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-of" ]; then outbase="$arg"; fi
  prev="$arg"
done
if [ -n "$outbase" ]; then
  cat > "$outbase.json" <<'EOF_STUB_JSON'
{"result":{"language":"en"},"transcription":[{"offsets":{"from":0,"to":1000},"text":" stub transcript"}]}
EOF_STUB_JSON
fi
echo "whisper_print_progress_callback: progress =  100%" 1>&2
exit 0
`;

/** Derived from whisperVad.ts's SEGMENT_LINE: one "Speech segment" line, as its own doc comment specifies. */
const VAD_BODY = `
case " $* " in
  *" --help "*)
    exit 0
    ;;
esac
echo "Detected 1 speech segments:"
echo "Speech segment 0: start = 0.00, end = 100.00"
exit 0
`;

/** Derived from sherpaDiarizer.ts's TURN_LINE: one turn line, as its own doc comment specifies. */
const DIARIZER_BODY = `
case " $* " in
  *" --help "*)
    exit 0
    ;;
esac
echo "1.583 -- 3.406 speaker_00"
exit 0
`;

/** Writes whatever the last argument names, so `toWav16kMono` has an output file to hand the next stage. */
const FFMPEG_BODY = `
case " $* " in
  *" -version "*)
    echo "ffmpeg version stub"
    exit 0
    ;;
esac
last=""
for arg in "$@"; do last="$arg"; done
: > "$last"
exit 0
`;

/** A duration ffprobe.probe() can parse, so import never fails on a stubbed recording. */
const FFPROBE_BODY = `
case " $* " in
  *" -version "*)
    echo "ffprobe version stub"
    exit 0
    ;;
esac
echo '{"format":{"duration":"5.0"}}'
exit 0
`;

interface Engines {
  /** Prepend this to PATH so ffmpeg/ffprobe (bare names, never configurable) resolve to the stubs. */
  readonly pathEntry: string;
  readonly whisper: { argv(): Promise<string[][]> };
  readonly vad: { argv(): Promise<string[][]> };
  readonly diarizer: { argv(): Promise<string[][]> };
}

/**
 * Points every engine binary and model this feature touches at a stub or a
 * placeholder, so `transcribe --diarize --multilingual` and `doctor` all run
 * to completion without ffmpeg, whisper.cpp, or sherpa-onnx installed.
 * Model files are never read for content -- only checked for existence by
 * `doctor` -- so an empty placeholder is enough.
 */
async function setupEngines(sandbox: Sandbox): Promise<Engines> {
  const stubDir = join(sandbox.home, 'stub-bin');
  await mkdir(stubDir, { recursive: true });
  const whisper = await writeStub(stubDir, 'whisper-cli', WHISPER_BODY);
  const vad = await writeStub(stubDir, 'whisper-vad-speech-segments', VAD_BODY);
  const diarizer = await writeStub(
    stubDir,
    'sherpa-onnx-offline-speaker-diarization',
    DIARIZER_BODY,
  );
  await writeStub(stubDir, 'ffmpeg', FFMPEG_BODY);
  await writeStub(stubDir, 'ffprobe', FFPROBE_BODY);

  const modelsDir = join(sandbox.home, 'models');
  await mkdir(modelsDir, { recursive: true });
  const whisperModel = join(modelsDir, 'whisper.bin');
  const vadModel = join(modelsDir, 'vad.bin');
  const segmentationModel = join(modelsDir, 'segmentation.onnx');
  const embeddingModel = join(modelsDir, 'embedding.onnx');
  await Promise.all(
    [whisperModel, vadModel, segmentationModel, embeddingModel].map((path) =>
      writeFile(path, 'stub model, never read for content\n', 'utf8'),
    ),
  );

  await sandbox.writeConfig(
    `stt:\n` +
      `  whisperCpp:\n` +
      `    model: ${whisperModel}\n` +
      `    vadModel: ${vadModel}\n` +
      `  diarization:\n` +
      `    segmentationModel: ${segmentationModel}\n` +
      `    embeddingModel: ${embeddingModel}\n`,
  );

  return {
    pathEntry: `${stubDir}${delimiter}${process.env['PATH'] ?? ''}`,
    whisper,
    vad,
    diarizer,
  };
}

describe('resource flags', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('passes the budget it computed to whisper and a smaller one to the diarizer', async () => {
    // The expectation is computed the same way the code computes it, so this
    // holds on any machine rather than on one core count.
    const budget = localResourceBudget(localCpuTopology(), { maxCpuPercent: 100 });
    const engines = await setupEngines(sandbox);
    const env = { PATH: engines.pathEntry };

    const imported = await sandbox.run(['import', EN_WAV], { env });
    const id = parseImportLine(imported.stdout.trim()).id;

    const transcribed = await sandbox.run(
      ['transcribe', id, '--diarize', '--max-cpu', '100', '--denoise', 'off'],
      { env },
    );
    expect(transcribed.code).toBe(0);

    const whisperArgv = (await engines.whisper.argv()).flat();
    expect(whisperArgv).toEqual(expect.arrayContaining(['-t', String(budget.threads)]));

    const diarizerArgv = (await engines.diarizer.argv())[0]!.join(' ');
    expect(diarizerArgv).toContain(`--segmentation.num-threads=${budget.cappedThreads}`);
    expect(diarizerArgv).toContain(`--embedding.num-threads=${budget.cappedThreads}`);
  });

  it('never gives a capped engine more than the measured optimum', async () => {
    // The regression this field exists to prevent: both capped engines were
    // measured fastest at 6 threads and much slower above it, so the cap is an
    // absolute ceiling rather than a fraction of the machine. Pure
    // computation -- no engine spawned.
    //
    // Stated as the invariant rather than as "capped is smaller than the
    // ceiling": on a machine with 6 or fewer usable cores the two are equal
    // and nothing is being capped, which is correct. An earlier version of
    // this test guarded on `threads > 2`, calibrated for a `base - 2` rule
    // that no longer exists, and would have failed on any 4-core runner.
    const budget = localResourceBudget(localCpuTopology(), { maxCpuPercent: 100 });
    expect(budget.cappedThreads).toBeLessThanOrEqual(CAPPED_MAX_THREADS);
    expect(budget.cappedThreads).toBeLessThanOrEqual(budget.threads);
    expect(budget.cappedThreads).toBeGreaterThanOrEqual(1);
    if (budget.threads > CAPPED_MAX_THREADS) {
      expect(budget.cappedThreads).toBe(CAPPED_MAX_THREADS);
    }
  });

  it('gives whisper fewer threads at a lower percent', async () => {
    const high = localResourceBudget(localCpuTopology(), { maxCpuPercent: 100 }).threads;
    const low = localResourceBudget(localCpuTopology(), { maxCpuPercent: 10 }).threads;
    const engines = await setupEngines(sandbox);
    const env = { PATH: engines.pathEntry };

    const imported = await sandbox.run(['import', EN_WAV], { env });
    const id = parseImportLine(imported.stdout.trim()).id;

    const first = await sandbox.run(['transcribe', id, '--max-cpu', '100', '--denoise', 'off'], {
      env,
    });
    expect(first.code).toBe(0);
    const second = await sandbox.run(
      ['transcribe', id, '--force', '--max-cpu', '10', '--denoise', 'off'],
      { env },
    );
    expect(second.code).toBe(0);

    const calls = await engines.whisper.argv();
    const threadsOf = (argv: string[]): string => argv[argv.indexOf('-t') + 1]!;
    expect(threadsOf(calls[0]!)).toBe(String(high));
    expect(threadsOf(calls[1]!)).toBe(String(low));
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(1);
  });

  it('omits -ng by default and includes it with --no-gpu', async () => {
    const engines = await setupEngines(sandbox);
    const env = { PATH: engines.pathEntry };

    const imported = await sandbox.run(['import', EN_WAV], { env });
    const id = parseImportLine(imported.stdout.trim()).id;

    const withGpu = await sandbox.run(['transcribe', id, '--denoise', 'off'], { env });
    expect(withGpu.code).toBe(0);
    const withoutGpu = await sandbox.run(
      ['transcribe', id, '--force', '--no-gpu', '--denoise', 'off'],
      { env },
    );
    expect(withoutGpu.code).toBe(0);

    const calls = await engines.whisper.argv();
    expect(calls[0]).not.toContain('-ng');
    expect(calls[1]).toContain('-ng');
  });

  it('never passes -ng to the vad binary', async () => {
    // That binary has no such flag: passing it would make every multilingual
    // run fail at segmentation.
    const engines = await setupEngines(sandbox);
    const env = { PATH: engines.pathEntry };

    const imported = await sandbox.run(['import', EN_WAV], { env });
    const id = parseImportLine(imported.stdout.trim()).id;

    const transcribed = await sandbox.run(
      ['transcribe', id, '--multilingual', '--no-gpu', '--denoise', 'off'],
      { env },
    );
    expect(transcribed.code).toBe(0);

    const vadArgv = (await engines.vad.argv()).flat().join(' ');
    expect(vadArgv).not.toContain('-ng');
  });

  it('never passes a flag that was measured and rejected', async () => {
    // sherpa's provider (measured 20% slower), llama's -ngl (unmeasurable
    // here) and whisper's -p (trades accuracy for speed). If a later change
    // reintroduces one without a measurement, this fails.
    const engines = await setupEngines(sandbox);
    const env = { PATH: engines.pathEntry };

    const imported = await sandbox.run(['import', EN_WAV], { env });
    const id = parseImportLine(imported.stdout.trim()).id;

    const transcribed = await sandbox.run(
      ['transcribe', id, '--diarize', '--multilingual', '--no-gpu', '--denoise', 'off'],
      { env },
    );
    expect(transcribed.code).toBe(0);

    const everything = [
      ...(await engines.whisper.argv()).flat(),
      ...(await engines.vad.argv()).flat(),
      ...(await engines.diarizer.argv()).flat(),
    ].join(' ');
    expect(everything).not.toContain('provider');
    expect(everything).not.toContain('-ngl');
    expect(everything).not.toMatch(/(^| )-p( |$)/);
  });

  it.each(['0', '101', 'abc'])('refuses --max-cpu %s and spawns nothing', async (value) => {
    const engines = await setupEngines(sandbox);
    const env = { PATH: engines.pathEntry };
    const { code, stderr } = await sandbox.run(['transcribe', 'ZZZZZZZZ', '--max-cpu', value], {
      env,
    });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/1.*100/);
    expect(await engines.whisper.argv()).toEqual([]);
  });

  it('refuses an unknown --denoise mode, naming the three', async () => {
    const engines = await setupEngines(sandbox);
    const env = { PATH: engines.pathEntry };
    const { code, stderr } = await sandbox.run(
      ['transcribe', 'ZZZZZZZZ', '--denoise', 'sometimes'],
      { env },
    );
    expect(code).not.toBe(0);
    for (const mode of ['auto', 'on', 'off']) expect(stderr).toContain(mode);
  });

  it('forwards all three flags to a detached child', async () => {
    // Asserted from the child's own recorded argv, not from the parent's:
    // the parent exits immediately, and a flag lost in between would be
    // invisible.
    const budget = localResourceBudget(localCpuTopology(), { maxCpuPercent: 50 });
    const engines = await setupEngines(sandbox);
    const env = { PATH: engines.pathEntry };

    const imported = await sandbox.run(['import', EN_WAV], { env });
    const id = parseImportLine(imported.stdout.trim()).id;

    const detached = await sandbox.run(
      ['transcribe', id, '--detach', '--max-cpu', '50', '--no-gpu', '--denoise', 'off'],
      { env },
    );
    expect(detached.code).toBe(0);
    const jobId = parseDetachId(detached.stdout);
    const state = await waitForTerminal(sandbox, jobId);
    expect(state.state).toBe('done');

    const childArgv = (await engines.whisper.argv())[0]!;
    expect(childArgv).toEqual(expect.arrayContaining(['-t', String(budget.threads)]));
    expect(childArgv).toContain('-ng');
  });

  it('prints the acceleration checks and still exits zero', async () => {
    const engines = await setupEngines(sandbox);
    const env = { PATH: engines.pathEntry };
    const { code, stdout } = await sandbox.run(['doctor'], { env });
    expect(stdout).toContain('cpu');
    expect(stdout).toContain('neural engine');
    expect(code).toBe(0);
  });

  it('leads with the setup note, naming one case and not both', async () => {
    // An outside agent reading doctor reads the top. The two cases give
    // opposite advice, so printing both would be worse than printing neither.
    const engines = await setupEngines(sandbox);
    const env = { PATH: engines.pathEntry };
    const { stdout } = await sandbox.run(['doctor'], { env });
    // Not a bare `stdout.includes('GPU build')`: the CPU-only message's own
    // text is "...than on a GPU build...", so that substring is present in
    // BOTH cases and cannot tell them apart. Each case's distinguishing
    // prefix -- "GPU build (" with the backend list, versus "CPU-only
    // build:" -- is what actually never appears in the other.
    const first = stdout.split('\n').find((line) => line.trim() !== '') ?? '';
    expect(first).toMatch(/GPU build \(|CPU-only build:/);
    expect(stdout.includes('GPU build (') && stdout.includes('CPU-only build:')).toBe(false);
  });

  it('never tells the agent to ask about --max-cpu', async () => {
    // The rule this feature ships with: the agent should UNDERSTAND what
    // makes ailoud fast, and never spend a turn asking the user to set a
    // flag whose default is already right.
    const engines = await setupEngines(sandbox);
    const env = { PATH: engines.pathEntry };
    const { stdout } = await sandbox.run(['doctor'], { env });
    expect(stdout).not.toContain('--max-cpu');
  });

  it('writes a rules block that tells the agent not to ask, under its ceiling', async () => {
    // --target and --location, and the rules file path, all taken from
    // e2e/tests/mcp-install.spec.ts and apps/cli/src/mcp/agents.ts rather
    // than from a guessed "--agent claude-code" and a root CLAUDE.md: a
    // fresh sandbox has neither yet, so the preferred candidate is
    // .claude/CLAUDE.md.
    const result = await sandbox.run([
      'mcp',
      'install',
      '--target',
      'claude',
      '--location',
      'local',
    ]);
    expect(result.code).toBe(0);
    const rules = await readFile(join(sandbox.projectDir, '.claude', 'CLAUDE.md'), 'utf8');
    expect(rules).toMatch(/not ask about CPU or GPU/i);
    expect(rules).not.toContain('--max-cpu');
  });
});

// ---------------------------------------------------------------------------
// Real audio, below. Everything above this line drives the binary through
// stub engines and belongs to both jest projects. Everything from here on
// spawns a real ffmpeg/whisper-cli against a real model and belongs to
// `tools` alone -- guarded by AILOUD_E2E_TOOLS (see the file header and
// jest.config.cjs), which is why the whole describe block below is wrapped
// in a runtime check rather than split into a second file: Jest's testMatch
// assigns a whole file to a project, never one describe block within it.

const REAL_TOOLS = process.env['AILOUD_E2E_TOOLS'] === 'true';

const NOISY_WAV = join(FIXTURES_DIR, 'noisy-short.wav');

/**
 * A real, working whisper.cpp model this block needs to actually transcribe
 * rather than merely check that a path exists. There is no packaged fixture
 * model -- whisper.cpp models are hundreds of megabytes -- so this points at
 * the same manual-install location the maintainer's own
 * `~/.config/ailoud/config.yaml` uses: a `models/` directory under the real,
 * unsandboxed XDG data dir. See pipeline.spec.ts's own WHISPER_MODEL comment
 * for the full reasoning; kept as a second, local copy here rather than an
 * import because these are two independent spec files under Jest, neither of
 * which exports anything for the other to import.
 */
const REAL_HOME = process.env['HOME'] ?? '';
const WHISPER_MODEL = installedWhisperModel(REAL_HOME);

/** Below this, a transcript is close enough to the reference to prove the right audio reached the right model. */
const WER_THRESHOLD = 0.2;

interface ShowJson {
  readonly segments: ReadonlyArray<{ readonly text: string }>;
}

/**
 * The transcript's actual words, from `show --format json`'s segments --
 * not `--format text`, which prefixes every line with a timestamp that would
 * count as extra reference-mismatched words. See pipeline.spec.ts's own
 * transcriptTextFromShowJson for the full reasoning; a second small copy,
 * for the same reason WHISPER_MODEL above is one.
 */
function transcriptTextFromShowJson(raw: string): string {
  const parsed = JSON.parse(raw) as ShowJson;
  return parsed.segments.map((segment) => segment.text).join(' ');
}

/** The reference transcript for a fixture (fixtures/<name>.txt), trimmed. */
async function reference(name: string): Promise<string> {
  return (await readFile(join(FIXTURES_DIR, `${name}.txt`), 'utf8')).trim();
}

/**
 * Reads a job's append-only log file: jobsDir/<id>.log, plain text, one line
 * per notice (see apps/cli/src/jobs/log.ts and the `onNotice` wiring in
 * apps/cli/src/commands/transcribe.ts). Distinct from the job STATE file
 * (`readJobState`, above): the denoise decision is written by `onNotice`,
 * which reaches only the job log, never the terminal or the state document.
 */
async function readJobLog(sandbox: Sandbox, jobId: string): Promise<string> {
  return readFile(join(sandbox.dataDir, 'jobs', `${jobId}.log`), 'utf8');
}

/**
 * Imports a fixture, transcribes it against the real, configured model, and
 * returns the transcript's text. Throws with the CLI's own stderr on a
 * non-zero exit, so a genuine defect is reported rather than swallowed into
 * a confusing downstream assertion failure.
 */
async function transcribeFixture(
  sandbox: Sandbox,
  fixturePath: string,
  extraArgs: readonly string[],
): Promise<string> {
  await sandbox.writeConfig(`stt:\n  whisperCpp:\n    model: ${WHISPER_MODEL}\n`);
  const imported = await sandbox.run(['import', fixturePath]);
  const id = parseImportLine(imported.stdout.trim()).id;
  const transcribed = await sandbox.run(['transcribe', id, ...extraArgs]);
  if (transcribed.code !== 0) {
    throw new Error(`transcribe failed (code ${transcribed.code}): ${transcribed.stderr}`);
  }
  const shown = await sandbox.run(['show', id, '--format', 'json']);
  return transcriptTextFromShowJson(shown.stdout);
}

(REAL_TOOLS ? describe : describe.skip)('resource limits against real audio', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it.each(['10', '100'])('transcribes en-short.wav correctly at --max-cpu %s', async (percent) => {
    // The limit changes speed, never output. This is the whole safety
    // property: a resource hint is an optimisation, never a precondition.
    const text = await transcribeFixture(sandbox, EN_WAV, ['--max-cpu', percent]);
    expect(wordErrorRate(await reference('en-short'), text)).toBeLessThan(WER_THRESHOLD);
  });

  it('transcribes the noisy fixture correctly with --denoise on', async () => {
    // Asserts the filter chain is HARMLESS. It deliberately does not claim
    // the denoising rescued anything: raw noisy-short.wav also transcribes
    // correctly (measured: 16.35 dB SNR, below the "noisy" threshold, yet
    // still within WER_THRESHOLD both raw and denoised) -- a test claiming a
    // rescue here would pass for the wrong reason.
    const text = await transcribeFixture(sandbox, NOISY_WAV, ['--denoise', 'on']);
    expect(wordErrorRate(await reference('noisy-short'), text)).toBeLessThan(WER_THRESHOLD);
  });

  it('leaves clean audio alone on auto, and says so in the job log', async () => {
    // --detach, because the "not denoised" line goes to the job log only:
    // a routine decision is not a warning and does not reach the terminal
    // (see denoiseMessage/onNotice in
    // packages/core/src/pipelines/transcribe.ts and
    // apps/cli/src/commands/transcribe.ts).
    await sandbox.writeConfig(`stt:\n  whisperCpp:\n    model: ${WHISPER_MODEL}\n`);
    const imported = await sandbox.run(['import', EN_WAV]);
    const id = parseImportLine(imported.stdout.trim()).id;

    const detached = await sandbox.run(['transcribe', id, '--denoise', 'auto', '--detach']);
    expect(detached.code).toBe(0);
    const jobId = parseDetachId(detached.stdout);
    const state = await waitForTerminal(sandbox, jobId);
    expect(state.state).toBe('done');

    const log = await readJobLog(sandbox, jobId);
    expect(log).toMatch(/not denoised/i);
    // The measured number travels with the decision. en-short.wav is 27.1 dB.
    expect(log).toMatch(/2[0-9]\.[0-9] dB/);

    const shown = await sandbox.run(['show', id, '--format', 'json']);
    const text = transcriptTextFromShowJson(shown.stdout);
    expect(wordErrorRate(await reference('en-short'), text)).toBeLessThan(WER_THRESHOLD);
  });

  it('names a real backend for whisper-cli, and names segmentation and diarization on the cpu line', async () => {
    await sandbox.writeConfig(`stt:\n  whisperCpp:\n    model: ${WHISPER_MODEL}\n`);
    await sandbox.run(['import', EN_WAV]); // ensures dataDir exists; irrelevant to this check
    const { code, stdout } = await sandbox.run(['doctor']);
    expect(code).toBe(0);
    // On any real ggml build at least one backend loads.
    expect(stdout).toMatch(/whisper backends\s+\S/);
    // Shape, not the numbers: they differ from machine to machine (see the
    // MEASURED comment on accelerationChecks in apps/cli/src/commands/doctor.ts).
    expect(stdout).toMatch(
      /cpu\s+\d+ logical(?:, \d+ performance)? -> \d+ threads, \d+ for segmentation and diarization, at \d+%/,
    );
  });
});
