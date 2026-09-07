import { describe, expect, it, vi } from 'vitest';
import { parseBackends, probeBackends } from './accelerator.js';

/** Verbatim from `whisper-cli --help` on an M1 Pro, homebrew ggml 0.22.0. */
const REAL_STDERR = [
  'load_backend: loaded BLAS backend from /opt/homebrew/Cellar/ggml/0.22.0/libexec/libggml-blas.so',
  'ggml_metal_device_init: GPU name:   MTL0 (Apple M1 Pro)',
  'load_backend: loaded MTL backend from /opt/homebrew/Cellar/ggml/0.22.0/libexec/libggml-metal.so',
  'load_backend: loaded CPU backend from /opt/homebrew/Cellar/ggml/0.22.0/libexec/libggml-cpu-apple_m1.so',
].join('\n');

describe('parseBackends', () => {
  it('reads every backend a real whisper build reports', () => {
    expect(parseBackends(REAL_STDERR)).toEqual(['BLAS', 'MTL', 'CPU']);
  });

  it('de-duplicates a backend named twice', () => {
    const output = 'load_backend: loaded CPU backend from a\nload_backend: loaded CPU backend from b';
    expect(parseBackends(output)).toEqual(['CPU']);
  });

  it('answers empty for output with no backend lines', () => {
    expect(parseBackends('usage: some-tool [options]')).toEqual([]);
  });

  it('answers empty for empty output', () => {
    expect(parseBackends('')).toEqual([]);
  });
});

describe('probeBackends', () => {
  it('reads stdout and stderr together, because ggml prints to stderr', async () => {
    // Measured: the load_backend lines arrive on stderr, before the usage
    // text. A probe that read only stdout would report no backends at all.
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: REAL_STDERR });
    expect(await probeBackends('whisper-cli', { run })).toEqual(['BLAS', 'MTL', 'CPU']);
  });

  it('ignores the exit code', async () => {
    // Several of these binaries print usage and exit non-zero for --help.
    // The output is still exactly what is wanted.
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: REAL_STDERR });
    expect(await probeBackends('whisper-cli', { run })).toEqual(['BLAS', 'MTL', 'CPU']);
  });

  it('answers empty rather than throwing when the binary is missing', async () => {
    const run = vi.fn().mockRejectedValue(new Error('was not found on PATH'));
    await expect(probeBackends('nope', { run })).resolves.toEqual([]);
  });

  it('spawns an argument array with a timeout', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await probeBackends('whisper-cli', { run });
    const [command, args, options] = run.mock.calls[0]!;
    expect(command).toBe('whisper-cli');
    expect(args).toEqual(['--help']);
    expect(options.timeoutMs).toBeGreaterThan(0);
  });
});
