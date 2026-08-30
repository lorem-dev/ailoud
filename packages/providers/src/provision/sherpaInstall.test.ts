import { describe, expect, it } from 'vitest';
import { SHERPA_VERSION, sherpaTarballUrl } from './sherpaInstall.js';

describe('sherpaTarballUrl', () => {
  it('pins the version rather than tracking latest', () => {
    expect(sherpaTarballUrl('darwin', 'arm64')).toContain(`/download/${SHERPA_VERSION}/`);
    expect(sherpaTarballUrl('darwin', 'arm64')).not.toContain('latest');
  });

  it('picks the macOS arm64 build', () => {
    expect(sherpaTarballUrl('darwin', 'arm64')).toContain('osx-arm64-shared.tar.bz2');
  });

  it('picks the Linux x64 build', () => {
    expect(sherpaTarballUrl('linux', 'x64')).toContain('linux-x64-shared.tar.bz2');
  });

  it('refuses macOS on anything but arm64, for which this release has no asset', () => {
    expect(() => sherpaTarballUrl('darwin', 'x64')).toThrow(/x64/);
  });

  it('refuses Linux arm64, for which no generic build is published', () => {
    // Only vendor NPU builds (axcl, axera, rknn) exist for that target, and
    // they are not usable here. Refusing beats installing something that
    // cannot run.
    expect(() => sherpaTarballUrl('linux', 'arm64')).toThrow(/arm64/);
  });

  it('refuses Windows', () => {
    expect(() => sherpaTarballUrl('win32', 'x64')).toThrow(/win32/);
  });
});
