// End-to-end suite: drives the built binary (apps/cli/dist/bin/laud.js)
// against real audio fixtures through the sandbox in ../src/cli.ts. Every
// `it` block below gets its own sandbox (own throwaway HOME/XDG dirs) and
// tears it down afterward.
//
// whisper-cli is not installed in every environment this suite runs in.
// The specs that need it are written and run anyway -- they are expected
// to fail loudly on such a machine, naming the missing binary, rather than
// being skipped. A suite that goes green by not running is worse than one
// that is honestly red. See the task report for exactly which specs need
// what to turn green.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sandbox } from '../src/cli';
import { makeSandbox } from '../src/cli';
import { wordErrorRate } from '../src/wer';

const REPO_ROOT = join(__dirname, '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');

const EN_WAV = join(FIXTURES_DIR, 'en-short.wav');
const EN_REFERENCE = readFileSync(join(FIXTURES_DIR, 'en-short.txt'), 'utf8').trim();
const RU_WAV = join(FIXTURES_DIR, 'ru-short.wav');
const MIXED_WAV = join(FIXTURES_DIR, 'mixed-short.wav');

const WER_THRESHOLD = 0.25;

/** A quick, local command; a few seconds is already generous. */
const GIT_STATUS_TIMEOUT_MS = 10_000;

/**
 * Real, working whisper.cpp models this suite needs for the mixed-language
 * spec below: unlike the doctor specs, which only check that a path exists,
 * that spec runs `--multilingual` end to end and inspects what it produces,
 * so a placeholder file will not do. There is no packaged fixture model --
 * whisper.cpp models are hundreds of megabytes -- so this points at the
 * same manual-install location the maintainer's own `~/.config/laud/config.yaml`
 * uses: a `models/` directory under the real, unsandboxed XDG data dir.
 * `process.env.HOME` here is deliberately the *outer* test-runner process's
 * HOME, not a sandbox's -- `makeSandbox()` only overrides the child
 * process's environment, never this file's own.
 */
const REAL_HOME = process.env['HOME'] ?? '';
const WHISPER_MODEL = join(REAL_HOME, '.local', 'share', 'laud', 'models', 'ggml-small.bin');
const VAD_MODEL = join(REAL_HOME, '.local', 'share', 'laud', 'models', 'ggml-silero-v5.1.2.bin');

/** A distinctive word from the English clause of fixtures/mixed-short.txt. */
const MIXED_EN_WORD = 'tomorrow';
/**
 * A distinctive word ("vecherom", "in the evening") from the Russian clause
 * of fixtures/mixed-short.txt, as a Unicode escape rather than a Cyrillic
 * literal so this source file stays ASCII-only.
 */
const MIXED_RU_WORD = '\u0432\u0435\u0447\u0435\u0440\u043e\u043c';

interface LsRow {
  readonly id: string;
  readonly sourcePath: string;
  readonly title: string | null;
  readonly durationMs: number;
  readonly mime: string;
  readonly importedAt: string;
  readonly language: string | null;
  readonly transcriptId: string | null;
}

interface ShowJson {
  readonly segments: ReadonlyArray<{ readonly text: string; readonly language: string | null }>;
}

/**
 * The transcript's actual words, from `show --format json`'s segments --
 * not `--format text`, which prefixes every line with a "[HH:MM:SS] "
 * timestamp. `wordErrorRate`'s normalize() keeps digits, so comparing
 * against the human-readable rendering would count those bracketed
 * timestamps as extra reference-mismatched words: a perfect transcription
 * of a one-segment, 9-word reference would then score 3/9 = 0.333 against
 * a 0.25 threshold, and the spec could never pass regardless of model
 * quality. Segment text carries none of that formatting.
 */
function transcriptTextFromShowJson(raw: string): string {
  const parsed = JSON.parse(raw) as ShowJson;
  return parsed.segments.map((segment) => segment.text).join(' ');
}

/** Parses an `import` output line: "<id>  imported|already present  <path>". */
function parseImportLine(line: string): { id: string; status: string; path: string } {
  const match = /^(\S+)\s+(imported|already present)\s+(.+)$/.exec(line);
  if (match === null) throw new Error(`unexpected import output: ${JSON.stringify(line)}`);
  return { id: match[1]!, status: match[2]!, path: match[3]! };
}

/** Parses a `transcribe` output line: "<id>  <language>  <n> segment(s)". */
function parseTranscribeLine(line: string): { id: string; language: string; count: number } {
  const match = /^(\S+)\s+(\S+)\s+(\d+) segments?$/.exec(line);
  if (match === null) throw new Error(`unexpected transcribe output: ${JSON.stringify(line)}`);
  return { id: match[1]!, language: match[2]!, count: Number(match[3]) };
}

/**
 * Names of `laud-*` temp directories currently in `$TMPDIR`, excluding the
 * sandbox directories this suite itself creates (`laud-e2e-*`, from
 * `makeSandbox()`), so this only catches leaks from `Fs.tempFile` -- the
 * pipeline's own temp allocation, not the harness's.
 */
function laudTempEntries(): string[] {
  return readdirSync(tmpdir()).filter(
    (name) => name.startsWith('laud-') && !name.startsWith('laud-e2e-'),
  );
}

/** True if `srt` parses as SRT: cue 1, an arrow line, and increasing timestamps. */
function isWellFormedSrt(srt: string): boolean {
  const blocks = srt.trim().split('\n\n');
  if (blocks.length === 0) return false;
  const starts: number[] = [];
  blocks.forEach((block, index) => {
    const lines = block.split('\n');
    if (lines[0] !== String(index + 1)) throw new Error(`cue index mismatch: ${block}`);
    const arrow = /^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> \d{2}:\d{2}:\d{2},\d{3}$/.exec(
      lines[1] ?? '',
    );
    if (arrow === null) throw new Error(`missing arrow line: ${block}`);
    const [, h, m, s, ms] = arrow;
    starts.push(Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + Number(ms));
    if ((lines[2] ?? '').trim() === '') throw new Error(`cue has no text: ${block}`);
  });
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i]! < starts[i - 1]!) return false;
  }
  return true;
}

describe('laud end-to-end', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('doctor on an unconfigured sandbox exits 3 and names the missing model', async () => {
    const result = await sandbox.run(['doctor']);
    expect(result.code).toBe(3);
    expect(result.stdout).toMatch(/whisper model\s+not configured/);
  });

  it('doctor exits 0 once the binary and model are both configured', async () => {
    // Only the model's *presence on disk* is checked by doctor, so a
    // placeholder file is enough to satisfy that half of the check. The
    // whisper binary check still shells out to whisper-cli for real --
    // on a machine without it, this is exactly where the suite is
    // expected to go red, naming the fix ("brew install whisper-cpp"). The
    // same goes for the VAD model and the whisper-vad-speech-segments
    // binary, which Homebrew installs alongside whisper-cli.
    const modelPath = join(sandbox.home, 'fake-model.bin');
    const vadModelPath = join(sandbox.home, 'fake-vad-model.bin');
    await sandbox.writeConfig(
      `stt:\n  whisperCpp:\n    model: ${modelPath}\n    vadModel: ${vadModelPath}\n`,
    );
    await sandbox.run(['import', EN_WAV]); // ensures dataDir exists; irrelevant to this check
    await writeFile(modelPath, 'not a real ggml model, just needs to exist\n', 'utf8');
    await writeFile(vadModelPath, 'not a real vad model, just needs to exist\n', 'utf8');

    const result = await sandbox.run(['doctor']);
    expect(result.code).toBe(0);
  });

  it('ls on an empty library reports that the library is empty', async () => {
    const human = await sandbox.run(['ls']);
    expect(human.code).toBe(0);
    expect(human.stdout.trim()).toBe('The library is empty. Add something with "laud import".');

    const json = await sandbox.run(['ls', '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout.trim())).toEqual([]);
  });

  it('import succeeds and prints an id', async () => {
    const result = await sandbox.run(['import', EN_WAV]);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = parseImportLine(lines[0]!);
    expect(parsed.status).toBe('imported');
    expect(parsed.path).toBe(EN_WAV);
    expect(parsed.id.length).toBeGreaterThan(0);
  });

  it('re-importing the same file reports "already present" with one recording in the library', async () => {
    const first = await sandbox.run(['import', EN_WAV]);
    const firstId = parseImportLine(first.stdout.trim()).id;

    const second = await sandbox.run(['import', EN_WAV]);
    expect(second.code).toBe(0);
    const secondParsed = parseImportLine(second.stdout.trim());
    expect(secondParsed.status).toBe('already present');
    expect(secondParsed.id).toBe(firstId);

    const ls = await sandbox.run(['ls', '--json']);
    const rows = JSON.parse(ls.stdout.trim()) as LsRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(firstId);
  });

  it('transcribe produces a transcript within 0.25 word error rate of the reference', async () => {
    const imported = await sandbox.run(['import', EN_WAV]);
    const id = parseImportLine(imported.stdout.trim()).id;

    const before = laudTempEntries();
    const transcribed = await sandbox.run(['transcribe', id]);
    expect(transcribed.code).toBe(0);
    // The temp directory transcribe allocates (and everything a provider
    // writes inside it, such as whisper-cli's JSON sidecar) must not
    // outlive the run: see Fs.tempFile / TempFile.remove().
    expect(laudTempEntries()).toEqual(before);
    const { count } = parseTranscribeLine(transcribed.stdout.trim());
    expect(count).toBeGreaterThan(0);

    const shown = await sandbox.run(['show', id, '--format', 'json']);
    expect(shown.code).toBe(0);
    const transcript = transcriptTextFromShowJson(shown.stdout);
    const wer = wordErrorRate(EN_REFERENCE, transcript);
    expect(wer).toBeLessThan(WER_THRESHOLD);
  });

  it('the Russian fixture transcribes with a detected language of "ru"', async () => {
    const imported = await sandbox.run(['import', RU_WAV]);
    const id = parseImportLine(imported.stdout.trim()).id;

    const transcribed = await sandbox.run(['transcribe', id]);
    expect(transcribed.code).toBe(0);
    const { language } = parseTranscribeLine(transcribed.stdout.trim());
    expect(language).toBe('ru');
  });

  it('the mixed-language fixture keeps both languages under --multilingual', async () => {
    // whisper detects one language per window and can transcribe a
    // code-switched clip into the wrong script entirely, silently discarding
    // whichever half lost. This fixture exists to exercise exactly that
    // risk: it genuinely code-switches -- an English clause spoken by an
    // English voice (Samantha), followed by a Russian clause spoken by a
    // Russian voice (Milena), concatenated into one clip (see
    // scripts/make-fixtures.mjs).
    //
    // Asserting that the detected language is merely "one of the two" would
    // pass at the exact moment half the recording is discarded -- whichever
    // language wins is trivially "one of the two". So this asserts both
    // halves actually survive: recognisable text from each clause, and at
    // least two distinct non-null values among the segments' `language`
    // fields, which is only possible if the recording was split into
    // per-language runs rather than tagged with a single language overall.
    await sandbox.writeConfig(
      `stt:\n  whisperCpp:\n    model: ${WHISPER_MODEL}\n    vadModel: ${VAD_MODEL}\n`,
    );
    const imported = await sandbox.run(['import', MIXED_WAV]);
    const id = parseImportLine(imported.stdout.trim()).id;

    const transcribed = await sandbox.run(['transcribe', id, '--multilingual']);
    expect(transcribed.code).toBe(0);

    const shown = await sandbox.run(['show', id, '--format', 'json']);
    expect(shown.code).toBe(0);
    const parsed = JSON.parse(shown.stdout) as ShowJson;
    const transcript = transcriptTextFromShowJson(shown.stdout);
    const lowerTranscript = transcript.toLowerCase();

    if (!lowerTranscript.includes(MIXED_EN_WORD)) {
      throw new Error(
        `English clause missing: "${MIXED_EN_WORD}" not found; transcript: ${JSON.stringify(transcript)}`,
      );
    }
    if (!lowerTranscript.includes(MIXED_RU_WORD)) {
      throw new Error(
        `Russian clause missing: "${MIXED_RU_WORD}" not found; transcript: ${JSON.stringify(transcript)}`,
      );
    }

    const distinctLanguages = new Set(
      parsed.segments.map((segment) => segment.language).filter((language) => language !== null),
    );
    if (distinctLanguages.size < 2) {
      throw new Error(
        `expected at least two distinct segment languages, got ${JSON.stringify([...distinctLanguages])}; transcript: ${JSON.stringify(transcript)}`,
      );
    }
  });

  it('transcribe --multilingual with no VAD model configured exits 3', async () => {
    // The VAD model is a second, separate piece of environment from the
    // whisper.cpp model above: `--multilingual` needs it to find speech
    // spans before language detection ever runs. Its absence is an
    // environment problem, not a transcription failure, so it must exit 3
    // the same way `doctor` reports it -- and this is the one place that
    // path is proven through `transcribe` itself, not just `doctor`.
    await sandbox.writeConfig(`stt:\n  whisperCpp:\n    model: ${WHISPER_MODEL}\n`);
    const imported = await sandbox.run(['import', EN_WAV]);
    const id = parseImportLine(imported.stdout.trim()).id;

    const transcribed = await sandbox.run(['transcribe', id, '--multilingual']);
    expect(transcribed.code).toBe(3);
    expect(transcribed.stderr).toMatch(/vadModel/);
  });

  it('show --format srt parses as SRT with increasing timestamps', async () => {
    const imported = await sandbox.run(['import', EN_WAV]);
    const id = parseImportLine(imported.stdout.trim()).id;
    const transcribed = await sandbox.run(['transcribe', id]);
    expect(transcribed.code).toBe(0);

    const shown = await sandbox.run(['show', id, '--format', 'srt']);
    expect(shown.code).toBe(0);
    expect(isWellFormedSrt(shown.stdout)).toBe(true);
  });

  it('show --format json round-trips and matches the segment count from ls --json', async () => {
    const imported = await sandbox.run(['import', EN_WAV]);
    const id = parseImportLine(imported.stdout.trim()).id;
    const transcribed = await sandbox.run(['transcribe', id]);
    expect(transcribed.code).toBe(0);
    const { count } = parseTranscribeLine(transcribed.stdout.trim());

    const shown = await sandbox.run(['show', id, '--format', 'json']);
    expect(shown.code).toBe(0);
    const parsed = JSON.parse(shown.stdout) as { segments: unknown[] };
    expect(parsed.segments).toHaveLength(count);

    const ls = await sandbox.run(['ls', '--json']);
    const rows = JSON.parse(ls.stdout.trim()) as LsRow[];
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
  });

  it('show on an unknown id exits 1; show --format pdf exits 2', async () => {
    const unknown = await sandbox.run(['show', 'no-such-id']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/No recording with id/);

    const badFormat = await sandbox.run(['show', 'no-such-id', '--format', 'pdf']);
    expect(badFormat.code).toBe(2);
    expect(badFormat.stderr).toMatch(/Unknown format "pdf"/);
  });

  it('leaves the repository working tree clean', async () => {
    // Runs after every other spec's sandbox has been torn down. If any
    // spec, or the harness itself, ever wrote outside its sandbox, this
    // is where it would show up.
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: GIT_STATUS_TIMEOUT_MS,
    });
    expect(status.trim()).toBe('');
  });
});
