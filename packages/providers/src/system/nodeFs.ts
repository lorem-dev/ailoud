import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fs, TempFile } from '@laud/core';

/** True for the one stat failure that legitimately means "does not exist". */
function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class NodeFs implements Fs {
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error; // permission-denied and friends are real errors, not "missing"
    }
  }
  async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
  async sha256(path: string): Promise<string> {
    const hash = createHash('sha256');
    // node:fs's read stream types its chunk as `string | Buffer` because the
    // encoding option can request strings; this stream never sets one, so
    // the chunk is always a Buffer.
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }
  async copyFile(source: string, destination: string): Promise<void> {
    await copyFile(source, destination);
  }
  async removeFile(path: string): Promise<void> {
    // force: a file already gone is the outcome the caller asked for, and
    // failing on it would make deletion non-idempotent for no gain.
    await rm(path, { force: true });
  }

  async listFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => join(directory, e.name))
      .sort();
  }
  async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
  async tempFile(extension: string): Promise<TempFile> {
    const dir = await mkdtemp(join(tmpdir(), 'laud-'));
    const path = join(dir, `audio${extension}`);
    return {
      path,
      // Removes the whole directory, not just this file: a provider (for
      // example whisper-cli) can write other output alongside it, and that
      // must not outlive the temp file it was derived from.
      remove: () => rm(dir, { force: true, recursive: true }),
    };
  }
}
