import { describe, expect, it } from 'vitest';
import { WHISPER_TAG, whisperTarballUrl } from './whisperInstall.js';

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
