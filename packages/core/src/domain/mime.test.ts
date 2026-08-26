import { describe, expect, it } from 'vitest';
import { mimeForPath } from './mime.js';

describe('mimeForPath', () => {
  it.each([
    ['a.mp3', 'audio/mpeg'],
    ['a.m4a', 'audio/mp4'],
    ['a.wav', 'audio/wav'],
    ['a.flac', 'audio/flac'],
    ['a.ogg', 'audio/ogg'],
    ['a.opus', 'audio/opus'],
    ['a.mp4', 'video/mp4'],
    ['a.mkv', 'video/x-matroska'],
    ['A.MP3', 'audio/mpeg'],
  ])('maps %s to %s', (path, mime) => {
    expect(mimeForPath(path)).toBe(mime);
  });

  it('returns null for an unknown extension', () => {
    expect(mimeForPath('notes.txt')).toBeNull();
  });
});
