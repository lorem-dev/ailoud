import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FailureError } from '@ailoud/core';

export interface DownloadOptions {
  readonly onProgress?: (received: number, total: number | null) => void;
  readonly fetchImpl?: typeof fetch;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Downloads `url` to `targetPath`, atomically.
 *
 * The body streams into `<targetPath>.part` and is renamed onto the target
 * only once it is complete. A 465 MB model interrupted at 300 MB must never
 * leave a file that `doctor` reports as present -- that failure would
 * resurface far away, as whisper failing to load a model, and be miserable
 * to trace back to a dropped connection.
 *
 * Completeness is judged against the response's own Content-Length, not
 * against a size compiled into ailoud: an upstream reupload should not be able
 * to make installation fail. When the server advertises no length, the
 * stream ending cleanly is all there is to go on, and that is accepted.
 */
export async function downloadFile(
  url: string,
  targetPath: string,
  options: DownloadOptions = {},
): Promise<void> {
  if (await exists(targetPath)) return;

  const fetchImpl = options.fetchImpl ?? fetch;
  const partPath = `${targetPath}.part`;
  await mkdir(dirname(targetPath), { recursive: true });

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new FailureError(`download failed for ${url}: HTTP ${response.status}`);
  }
  if (response.body === null) {
    throw new FailureError(`download failed for ${url}: the response had no body`);
  }

  const header = response.headers.get('content-length');
  // Number('') is 0, not NaN, so an empty header must be rejected by hand
  // before the numeric check below; a header that is otherwise not a
  // finite, non-negative number (non-numeric or negative) carries no usable
  // length either. Treat all of these the same as "no length advertised"
  // rather than as a total of 0, which would fail every download that
  // completed fine just because the server sent junk.
  const parsedHeader = header === null || header.trim() === '' ? NaN : Number(header);
  const total = Number.isFinite(parsedHeader) && parsedHeader >= 0 ? parsedHeader : null;
  let received = 0;

  try {
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      options.onProgress?.(received, total);
    });
    await pipeline(source, createWriteStream(partPath));

    if (total !== null && received !== total) {
      const direction = received < total ? 'incomplete' : 'longer than advertised';
      throw new FailureError(
        `download ${direction} for ${url}: expected ${total} bytes, received ${received}`,
      );
    }
    await rename(partPath, targetPath);
  } catch (error) {
    try {
      await rm(partPath, { force: true });
    } catch {
      // Cleanup failing (e.g. EACCES, EBUSY, a full disk on unlink) must not
      // replace the original error -- that original is the whole reason
      // this function exists: the network drop or truncation that explains
      // why the model is missing. A user seeing an unlink error instead
      // would have no idea their download actually died.
    }
    throw error;
  }
}
