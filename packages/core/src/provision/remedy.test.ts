import { describe, expect, it } from 'vitest';
import { WINDOWS_MANUAL_HINT, installHint } from './remedy.js';

describe('installHint', () => {
  it('names brew on macOS', () => {
    expect(installHint('ffmpeg', 'darwin')).toBe('brew install ffmpeg');
    expect(installHint('whisper', 'darwin')).toBe('brew install whisper-cpp');
  });

  it('names apt on Linux, and does not claim a whisper package exists', () => {
    expect(installHint('ffmpeg', 'linux')).toBe('sudo apt-get install ffmpeg');
    // There is no apt package for whisper.cpp -- the hint must send the user
    // to "ailoud setup" rather than to a package that will not be found.
    expect(installHint('whisper', 'linux')).toBe('ailoud setup');
  });

  it('sends Windows users to the manual steps, never in a circle back to ailoud setup', () => {
    // `ailoud setup` refuses to provision Windows, so recommending it here
    // would loop the user: doctor says run setup, setup says it cannot help.
    for (const target of ['ffmpeg', 'whisper', 'diarizer'] as const) {
      expect(installHint(target, 'win32')).toBe(WINDOWS_MANUAL_HINT);
      expect(installHint(target, 'win32')).not.toContain('ailoud setup');
    }
  });

  it('still falls back to ailoud setup for whisper on an unrecognized unix', () => {
    expect(installHint('whisper', 'freebsd')).toBe('ailoud setup');
  });

  it('sends the diarizer to "ailoud setup" on both macOS and Linux -- sherpa-onnx has no brew formula', () => {
    // Unlike whisper, which uses brew on macOS, sherpa-onnx is fetched by
    // ailoud itself on every supported platform (see sherpaInstall.ts), so
    // macOS must not get the brew hint whisper gets.
    expect(installHint('diarizer', 'darwin')).toBe('ailoud setup');
    expect(installHint('diarizer', 'linux')).toBe('ailoud setup');
    expect(installHint('diarizer', 'darwin')).not.toContain('brew');
  });
});
