import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedVadModel, installedWhisperModel, modelsDir } from './models';

/**
 * These run under vitest, not jest: the helper is picked by the e2e specs at
 * module load, so a mistake here would surface as every transcribing spec
 * pointing at the wrong file -- and those specs only run on a provisioned
 * machine, where the failure would be a CI-only surprise.
 */
describe('installedWhisperModel', () => {
  let home: string;
  let models: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ailoud-models-test-'));
    models = modelsDir(home);
    await mkdir(models, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('finds the installed transcription model whatever it is called', async () => {
    await writeFile(join(models, 'ggml-large-v3-turbo-q5_0.bin'), 'x');

    expect(installedWhisperModel(home)).toBe(join(models, 'ggml-large-v3-turbo-q5_0.bin'));
  });

  it('ignores the vad model, which lives in the same directory', async () => {
    // The vad file is made the NEWEST on purpose. Written in either order it
    // would lose to the whisper model on the mtime tiebreak, so the case
    // would pass with the exclusion deleted -- proving nothing. Made newest,
    // only the exclusion can produce the right answer.
    const whisper = join(models, 'ggml-small.bin');
    const vad = join(models, 'ggml-silero-v5.1.2.bin');
    await writeFile(whisper, 'x');
    await writeFile(vad, 'x');
    const future = new Date(Date.now() + 60_000);
    await utimes(vad, future, future);

    expect(installedWhisperModel(home)).toBe(whisper);
  });

  it('ignores files that are not whisper models', async () => {
    // Same reasoning as above: the decoys are the newest files present.
    const whisper = join(models, 'ggml-base.bin');
    await writeFile(whisper, 'x');
    const future = new Date(Date.now() + 60_000);
    for (const decoy of ['qwen2.5-3b-instruct-q4_k_m.gguf', 'sherpa-pyannote-3-0.onnx']) {
      await writeFile(join(models, decoy), 'x');
      await utimes(join(models, decoy), future, future);
    }

    expect(installedWhisperModel(home)).toBe(whisper);
  });

  it('prefers the most recently written model when several are installed', async () => {
    const older = join(models, 'ggml-small.bin');
    const newer = join(models, 'ggml-large-v3-turbo-q5_0.bin');
    await writeFile(older, 'x');
    await writeFile(newer, 'x');
    const past = new Date(Date.now() - 60_000);
    await utimes(older, past, past);

    expect(installedWhisperModel(home)).toBe(newer);
  });

  it('returns a path rather than throwing when the directory is empty', async () => {
    // The suite's rule is that a spec needing whisper fails loudly naming the
    // missing file. Throwing here would instead break collection of the whole
    // spec file, since the constant is evaluated at module load.
    expect(installedWhisperModel(home)).toBe(join(models, 'ggml-no-model-installed.bin'));
  });

  it('returns a path rather than throwing when the directory does not exist', async () => {
    await rm(models, { recursive: true, force: true });

    expect(installedWhisperModel(home)).toBe(join(models, 'ggml-no-model-installed.bin'));
  });

  it('names the vad model the provisioner installs', () => {
    expect(installedVadModel(home)).toBe(join(models, 'ggml-silero-v5.1.2.bin'));
  });
});
