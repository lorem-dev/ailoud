import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeFs } from './nodeFs.js';

describe('NodeFs.tempFile', () => {
  it('remove() deletes the whole directory it allocated, not just the file', async () => {
    const fs = new NodeFs();
    const temp = await fs.tempFile('.wav');
    expect(existsSync(temp.path)).toBe(false); // allocated, not yet written

    const tempDir = dirname(temp.path);
    writeFileSync(temp.path, 'wav bytes');
    // A provider writing a sidecar file next to the temp file, exactly like
    // whisper-cli's <outputBase>.json.
    const sidecar = join(tempDir, 'audio.json');
    writeFileSync(sidecar, '{"transcription":[]}');

    await temp.remove();

    expect(existsSync(temp.path)).toBe(false);
    expect(existsSync(sidecar)).toBe(false);
    expect(existsSync(tempDir)).toBe(false);
  });

  it('allocates a fresh directory per call', async () => {
    const fs = new NodeFs();
    const a = await fs.tempFile('.wav');
    const b = await fs.tempFile('.wav');
    expect(dirname(a.path)).not.toBe(dirname(b.path));
    await Promise.all([a.remove(), b.remove()]);
  });
});

describe('NodeFs.exists / isDirectory', () => {
  it('re-throws a stat error that is not "not found"', async () => {
    const fs = new NodeFs();
    const dir = mkdtempSync(join(tmpdir(), 'laud-test-'));
    const restricted = join(dir, 'no-access');
    writeFileSync(restricted, 'x');
    // Traversing through a file as if it were a directory is EN OTDIR, not
    // ENOENT: exists()/isDirectory() must surface it instead of reporting
    // "does not exist".
    const insidePseudoDir = join(restricted, 'child');
    try {
      await expect(fs.exists(insidePseudoDir)).rejects.toBeTruthy();
      await expect(fs.isDirectory(insidePseudoDir)).rejects.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exists() is false and isDirectory() is false for a path that is genuinely missing', async () => {
    const fs = new NodeFs();
    const dir = mkdtempSync(join(tmpdir(), 'laud-test-'));
    try {
      expect(await fs.exists(join(dir, 'missing'))).toBe(false);
      expect(await fs.isDirectory(join(dir, 'missing'))).toBe(false);
      expect((await readdir(dir)).length).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
