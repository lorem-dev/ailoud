import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadFile } from './download.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ailoud-download-'));
}

function respond(body: string, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-length': String(Buffer.byteLength(body)), ...headers },
    })) as unknown as typeof fetch;
}

describe('downloadFile', () => {
  it('writes the body to the target path', async () => {
    const dir = await tempDir();
    const target = join(dir, 'model.bin');
    await downloadFile('https://example.test/m', target, { fetchImpl: respond('hello') });
    expect(await readFile(target, 'utf8')).toBe('hello');
  });

  it('leaves no .part file behind on success', async () => {
    const dir = await tempDir();
    await downloadFile('https://example.test/m', join(dir, 'model.bin'), {
      fetchImpl: respond('hello'),
    });
    expect(await readdir(dir)).toEqual(['model.bin']);
  });

  it('rejects a truncated body and does NOT create the target', async () => {
    const dir = await tempDir();
    const target = join(dir, 'model.bin');
    // Content-Length claims 99 bytes; the body is 5. Node's Response keeps a
    // header set explicitly (verified against this repo's Node version)
    // rather than recomputing it from the string body, so the lie survives
    // for downloadFile to catch.
    const lying = respond('hello', { 'content-length': '99' });
    await expect(
      downloadFile('https://example.test/m', target, { fetchImpl: lying }),
    ).rejects.toThrow(/incomplete/i);
    await expect(readFile(target, 'utf8')).rejects.toThrow();
  });

  it('cleans up the .part file after a failure', async () => {
    const dir = await tempDir();
    const lying = respond('hello', { 'content-length': '99' });
    await downloadFile('https://example.test/m', join(dir, 'model.bin'), {
      fetchImpl: lying,
    }).catch(() => undefined);
    expect(await readdir(dir)).toEqual([]);
  });

  it('reports a non-200 with the status and does not write', async () => {
    const dir = await tempDir();
    const notFound = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    await expect(
      downloadFile('https://example.test/m', join(dir, 'model.bin'), { fetchImpl: notFound }),
    ).rejects.toThrow(/404/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('skips the download when the target already exists', async () => {
    const dir = await tempDir();
    const target = join(dir, 'model.bin');
    await writeFile(target, 'already here');
    let called = false;
    const counting = (async () => {
      called = true;
      return new Response('new');
    }) as unknown as typeof fetch;
    await downloadFile('https://example.test/m', target, { fetchImpl: counting });
    expect(called).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('already here');
  });

  it('reports progress against the advertised total', async () => {
    const dir = await tempDir();
    const seen: (number | null)[] = [];
    await downloadFile('https://example.test/m', join(dir, 'model.bin'), {
      fetchImpl: respond('hello'),
      onProgress: (_received, total) => seen.push(total),
    });
    expect(seen.at(-1)).toBe(5);
  });

  it('treats an empty content-length header as no length advertised, not a total of 0', async () => {
    const dir = await tempDir();
    const target = join(dir, 'model.bin');
    const seen: (number | null)[] = [];
    await downloadFile('https://example.test/m', target, {
      fetchImpl: respond('hello', { 'content-length': '' }),
      onProgress: (_received, total) => seen.push(total),
    });
    expect(await readFile(target, 'utf8')).toBe('hello');
    expect(seen.at(-1)).toBeNull();
  });

  it('treats a non-numeric content-length header as no length advertised', async () => {
    const dir = await tempDir();
    const target = join(dir, 'model.bin');
    const seen: (number | null)[] = [];
    await downloadFile('https://example.test/m', target, {
      fetchImpl: respond('hello', { 'content-length': 'not-a-number' }),
      onProgress: (_received, total) => seen.push(total),
    });
    expect(await readFile(target, 'utf8')).toBe('hello');
    expect(seen.at(-1)).toBeNull();
  });
});
