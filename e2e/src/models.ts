import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Where `ailoud setup` puts model files, under the real unsandboxed data dir. */
export function modelsDir(home: string): string {
  return join(home, '.local', 'share', 'ailoud', 'models');
}

/**
 * The transcription model an `ailoud setup` on this machine installed.
 *
 * Discovered rather than named. These specs used to hard-code
 * `ggml-small.bin`, which was the catalogue's default at the time; when the
 * default became `large-v3-turbo-q5_0` every transcribing spec would have
 * started pointing at a file `setup` no longer downloads. The specs do not
 * care WHICH real model they get -- they assert a transcript against a
 * reference with a loose error-rate ceiling that any genuine model clears --
 * so asking the filesystem what is there is both more robust and closer to
 * what they mean.
 *
 * The VAD model lives in the same directory and is not a transcription
 * model, so it is excluded by name. Where several models are installed the
 * most recently written one wins, which is the one the last `setup`
 * provisioned.
 *
 * Returns a path even when nothing is installed, deliberately: this suite's
 * standing rule is that a spec needing whisper fails loudly naming what is
 * missing rather than skipping, and a plausible path is what produces that
 * message.
 */
export function installedWhisperModel(home: string, env: NodeJS.ProcessEnv = process.env): string {
  // An explicit choice wins over discovery. CI sets this to a small model:
  // the specs here test the pipeline, not model quality, and the shipped
  // default is several times slower on a four-core runner -- it took the
  // provisioned suite from five minutes to nineteen. That the real default
  // downloads and installs is proven by the `setup` step itself, which is a
  // different question from whether `transcribe` works.
  const chosen = env['AILOUD_E2E_MODEL'];
  if (chosen !== undefined && chosen !== '') return chosen;
  const dir = modelsDir(home);
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return join(dir, 'ggml-no-model-installed.bin');
  }
  const candidates = entries
    .filter((name) => name.startsWith('ggml-') && name.endsWith('.bin') && !name.includes('silero'))
    .map((name) => join(dir, name))
    .sort((a, b) => mtime(b) - mtime(a));
  return candidates[0] ?? join(dir, 'ggml-no-model-installed.bin');
}

/** The VAD model, needed only by the `--multilingual` specs. */
export function installedVadModel(home: string): string {
  return join(modelsDir(home), 'ggml-silero-v5.1.2.bin');
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
