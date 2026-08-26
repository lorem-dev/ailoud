import { describe, expect, it } from 'vitest';
import { FakeAudioTool, FakeClock, FakeIds, InMemoryStore, MemFs } from '../testing/fakes.js';
import { importRecording, importPath } from './import.js';

const deps = () => ({
  fs: new MemFs({ '/in/talk.mp3': 'AUDIO', '/in/notes.txt': 'TEXT' }),
  store: new InMemoryStore(),
  audio: new FakeAudioTool(90_000),
  clock: new FakeClock(),
  ids: new FakeIds(),
  mediaRoot: '/data/media',
});

describe('importRecording', () => {
  it('stores the recording under a hash-sharded media path', async () => {
    const d = deps();
    const { recording, alreadyPresent } = await importRecording(d, { path: '/in/talk.mp3' });
    expect(alreadyPresent).toBe(false);
    expect(recording).toEqual({
      id: 'ID001',
      sha256: 'sha-AUDIO',
      sourcePath: '/in/talk.mp3',
      mediaPath: 'sh/sha-AUDIO.mp3',
      durationMs: 90_000,
      mime: 'audio/mpeg',
      title: null,
      notes: null,
      importedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(d.fs.files.has('/data/media/sh/sha-AUDIO.mp3')).toBe(true);
  });

  it('keeps the title and notes it is given', async () => {
    const d = deps();
    const { recording } = await importRecording(d, { path: '/in/talk.mp3', title: 'Standup' });
    expect(recording.title).toBe('Standup');
  });

  it('is a no-op for a file already in the library', async () => {
    const d = deps();
    // Same content as talk.mp3 under a different path -- identity is by
    // content, not by name, so this must resolve to the same recording.
    d.fs.files.set('/in/copy.mp3', 'AUDIO');
    const first = await importRecording(d, { path: '/in/talk.mp3' });
    const second = await importRecording(d, { path: '/in/copy.mp3' });
    expect(second.alreadyPresent).toBe(true);
    expect(second.recording.id).toBe(first.recording.id);
    expect(d.store.recordings.size).toBe(1);
  });

  it('refuses a file that is not media', async () => {
    const d = deps();
    await expect(importRecording(d, { path: '/in/notes.txt' })).rejects.toThrow(/not a media file/);
  });

  it('refuses a file that does not exist', async () => {
    const d = deps();
    await expect(importRecording(d, { path: '/in/missing.mp3' })).rejects.toThrow(/does not exist/);
  });
});

describe('importPath', () => {
  it('imports every media file in a directory and skips the rest', async () => {
    const d = deps();
    d.fs.dirs.add('/in');
    const results = await importPath(d, { path: '/in' });
    expect(results.map((r) => r.recording.sourcePath)).toEqual(['/in/talk.mp3']);
  });

  it('fails when a directory has no media files at all', async () => {
    const d = deps();
    d.fs.files.delete('/in/talk.mp3');
    d.fs.dirs.add('/in');
    await expect(importPath(d, { path: '/in' })).rejects.toThrow(/No media files found/);
  });

  it('fails for a directory whose only files are not media', async () => {
    const d = deps();
    d.fs.dirs.add('/onlytext');
    d.fs.files.set('/onlytext/notes.txt', 'TEXT');
    await expect(importPath(d, { path: '/onlytext' })).rejects.toThrow(/No media files found/);
  });

  it('fails for an empty directory', async () => {
    const d = deps();
    d.fs.dirs.add('/empty');
    await expect(importPath(d, { path: '/empty' })).rejects.toThrow(/No media files found/);
  });

  it('does not descend into a subdirectory looking for media', async () => {
    const d = deps();
    d.fs.dirs.add('/nested');
    d.fs.dirs.add('/nested/sub');
    d.fs.files.set('/nested/sub/talk.mp3', 'AUDIO');
    await expect(importPath(d, { path: '/nested' })).rejects.toThrow(/No media files found/);
  });
});
