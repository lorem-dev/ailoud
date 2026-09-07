import { run as defaultRunner } from '../process/run.js';

/**
 * Generous for a `--help`, because a ggml build enumerates and compiles its
 * Metal kernel libraries on the way to printing it -- twenty compiled
 * libraries on the machine this was measured on.
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * MEASURED, not guessed: a ggml binary announces each backend it loaded with
 * a line shaped `load_backend: loaded MTL backend from <path>`, on stderr,
 * before its usage text.
 */
const BACKEND_LINE = /load_backend: loaded (\S+) backend/g;

export function parseBackends(output: string): readonly string[] {
  const found = new Set<string>();
  for (const match of output.matchAll(BACKEND_LINE)) {
    const name = match[1];
    if (name !== undefined) found.add(name.toUpperCase());
  }
  return [...found];
}

const memo = new Map<string, Promise<readonly string[]>>();

async function read(
  binary: string,
  run: typeof defaultRunner,
): Promise<readonly string[]> {
  try {
    // An argument array, never a shell string.
    const result = await run(binary, ['--help'], { timeoutMs: PROBE_TIMEOUT_MS });
    // The exit code is deliberately ignored: several of these binaries print
    // usage and exit non-zero for --help, and the backend lines are already
    // there either way. Both streams, because ggml writes to stderr.
    return parseBackends(`${result.stdout}\n${result.stderr}`);
  } catch {
    // A missing binary, a permissions problem, a timeout. None of them is
    // worth a thrown error: this feeds a doctor line, and an empty list reads
    // as "could not tell", which is the truth.
    return [];
  }
}

/**
 * Which ggml backends `binary` loads -- `['BLAS', 'MTL', 'CPU']` on an Apple
 * Silicon homebrew whisper build.
 *
 * For `doctor`'s reporting only. Nothing on the transcription path may call
 * this: the answer is not used to decide a flag, because a backend that is
 * loaded is not evidence that using it is faster. Measuring sherpa's CoreML
 * provider found it twenty percent SLOWER than its CPU path, which is why
 * this module probes and reports rather than probes and switches.
 *
 * Memoised per binary regardless, so a future caller cannot make this a
 * per-recording subprocess.
 */
export function probeBackends(
  binary: string,
  deps: { readonly run?: typeof defaultRunner } = {},
): Promise<readonly string[]> {
  const run = deps.run ?? defaultRunner;
  if (deps.run !== undefined) return read(binary, run);
  const cached = memo.get(binary);
  if (cached !== undefined) return cached;
  const pending = read(binary, run);
  memo.set(binary, pending);
  return pending;
}
