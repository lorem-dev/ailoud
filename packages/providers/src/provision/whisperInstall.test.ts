import { describe, expect, it } from 'vitest';
import { WHISPER_TAG, installWhisper, whisperTarballUrl } from './whisperInstall.js';

describe('whisperTarballUrl', () => {
  it('pins the release tag rather than tracking latest', () => {
    expect(whisperTarballUrl('linux', 'x64')).toContain(`/download/${WHISPER_TAG}/`);
    expect(whisperTarballUrl('linux', 'x64')).not.toContain('latest');
  });

  it('picks the asset matching the CPU architecture', () => {
    expect(whisperTarballUrl('linux', 'x64')).toContain('whisper-bin-ubuntu-x64.tar.gz');
    expect(whisperTarballUrl('linux', 'arm64')).toContain('whisper-bin-ubuntu-arm64.tar.gz');
  });

  it('refuses an architecture with no published build', () => {
    expect(() => whisperTarballUrl('linux', 'ia32')).toThrow(/ia32/);
  });

  it('refuses a platform with no published build', () => {
    expect(() => whisperTarballUrl('win32', 'x64')).toThrow(/win32/);
  });
});

describe('installWhisper', () => {
  it('refuses the macOS brew route with no terminal, naming the exact command', async () => {
    // runInteractive has no timeout by design, so with nothing on stdin a
    // brew prompt (Xcode command line tools, a /usr/local ownership
    // question) would hang a CI job until the job itself times out. Nothing
    // is spawned here: the assertion is that the promise resolves at all.
    const result = await installWhisper({
      platform: 'darwin',
      arch: 'arm64',
      dataDir: '/nonexistent',
      interactive: false,
    });
    expect(result).toEqual({ kind: 'skipped', commands: ['brew install whisper-cpp'] });
  });

  it('refuses a platform with no automated route before touching the network', async () => {
    await expect(
      installWhisper({
        platform: 'win32',
        arch: 'x64',
        dataDir: '/nonexistent',
        interactive: false,
      }),
    ).rejects.toThrow(/win32/);
  });
});
