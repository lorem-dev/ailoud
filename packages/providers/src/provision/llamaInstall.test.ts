import { describe, expect, it } from 'vitest';
import { LLAMA_VERSION, installLlama, llamaTarballUrl } from './llamaInstall.js';

describe('llamaTarballUrl', () => {
  it('pins the release tag rather than tracking latest', () => {
    expect(llamaTarballUrl('linux', 'x64')).toContain(`/download/${LLAMA_VERSION}/`);
    expect(llamaTarballUrl('linux', 'x64')).not.toContain('latest');
  });

  it('picks the asset matching the platform and CPU', () => {
    expect(llamaTarballUrl('darwin', 'arm64')).toContain(`llama-${LLAMA_VERSION}-bin-macos-arm64.`);
    expect(llamaTarballUrl('darwin', 'x64')).toContain(`llama-${LLAMA_VERSION}-bin-macos-x64.`);
    expect(llamaTarballUrl('linux', 'arm64')).toContain(`llama-${LLAMA_VERSION}-bin-ubuntu-arm64.`);
    expect(llamaTarballUrl('linux', 'x64')).toContain(`llama-${LLAMA_VERSION}-bin-ubuntu-x64.`);
  });

  it('covers linux arm64, unlike the diarizer', () => {
    // Worth asserting rather than assuming: sherpa-onnx publishes no generic
    // linux-aarch64 build, so "every target is covered" is true here and
    // false one directory over.
    expect(() => llamaTarballUrl('linux', 'arm64')).not.toThrow();
  });

  it('is a gzip tarball, not bzip2', () => {
    // The extract flags differ from sherpa's, and getting this wrong fails
    // only after a two-gigabyte download.
    expect(llamaTarballUrl('linux', 'x64')).toMatch(/\.tar\.gz$/);
  });

  it('refuses an architecture with no published build, suggesting the way out', () => {
    expect(() => llamaTarballUrl('linux', 'ia32')).toThrow(/ia32/);
    expect(() => llamaTarballUrl('linux', 'ia32')).toThrow(/llm\.llamaCpp\.binary/);
  });

  it('refuses a platform with no published build', () => {
    expect(() => llamaTarballUrl('win32', 'x64')).toThrow(/win32/);
  });
});

describe('installLlama', () => {
  it('skips the brew route with no terminal instead of hanging on its prompts', async () => {
    // runInteractive has no timeout by design, and brew can stop to ask about
    // Xcode tools. Without a terminal to answer, this must report a skip.
    const result = await installLlama({
      platform: 'darwin',
      arch: 'arm64',
      dataDir: '/nonexistent',
      interactive: false,
      useBrew: true,
    });
    expect(result).toEqual({ binary: null, skipped: true });
  });
});
