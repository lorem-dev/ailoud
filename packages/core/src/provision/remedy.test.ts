import { describe, expect, it } from 'vitest';
import { installHint } from './remedy.js';

describe('installHint', () => {
  it('names brew on macOS', () => {
    expect(installHint('ffmpeg', 'darwin')).toBe('brew install ffmpeg');
    expect(installHint('whisper', 'darwin')).toBe('brew install whisper-cpp');
  });

  it('names apt on Linux, and does not claim a whisper package exists', () => {
    expect(installHint('ffmpeg', 'linux')).toBe('sudo apt-get install ffmpeg');
    // There is no apt package for whisper.cpp -- the hint must send the user
    // to "laud setup" rather than to a package that will not be found.
    expect(installHint('whisper', 'linux')).toBe('laud setup');
  });

  it('falls back to laud setup on platforms with no known package manager', () => {
    expect(installHint('ffmpeg', 'win32')).toBe('laud setup');
  });
});
