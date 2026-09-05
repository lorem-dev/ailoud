import type { AudioTool, Clock, Fs, Ids, RecordingStore } from '../domain/ports.js';
import type { Recording } from '../domain/model.js';
import { FailureError, UsageError } from '../domain/errors.js';
import { extensionOf, mimeForPath } from '../domain/mime.js';

export interface ImportDeps {
  readonly fs: Fs;
  readonly store: RecordingStore;
  readonly audio: AudioTool;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly mediaRoot: string;
}

export interface ImportRequest {
  readonly path: string;
  readonly title?: string;
  readonly notes?: string;
}

export interface ImportResult {
  readonly recording: Recording;
  readonly alreadyPresent: boolean;
}

export async function importRecording(
  deps: ImportDeps,
  request: ImportRequest,
): Promise<ImportResult> {
  if (!(await deps.fs.exists(request.path))) {
    throw new FailureError(`The file does not exist: ${request.path}`);
  }
  const mime = mimeForPath(request.path);
  if (mime === null) {
    throw new UsageError(`That is not a media file ailoud recognizes: ${request.path}`);
  }

  const sha256 = await deps.fs.sha256(request.path);
  const existing = await deps.store.findRecordingBySha(sha256);
  if (existing !== null) return { recording: existing, alreadyPresent: true };

  const { durationMs, recordedAt } = await deps.audio.probe(request.path);
  const mediaPath = `${sha256.slice(0, 2)}/${sha256}${extensionOf(request.path)}`;
  const absolute = `${deps.mediaRoot}/${mediaPath}`;
  await deps.fs.ensureDir(`${deps.mediaRoot}/${sha256.slice(0, 2)}`);
  await deps.fs.copyFile(request.path, absolute);

  const recording: Recording = {
    id: deps.ids.next(),
    sha256,
    sourcePath: request.path,
    mediaPath,
    durationMs,
    mime,
    title: request.title ?? null,
    notes: request.notes ?? null,
    // What the file says about itself, kept apart from when ailoud first saw
    // it. Null is the common case; recordedOrImportedAt resolves the fallback
    // at the point of use, so the distinction survives in storage.
    recordedAt,
    importedAt: deps.clock.nowIso(),
  };
  await deps.store.insertRecording(recording);
  return { recording, alreadyPresent: false };
}

/** Import one file, or every media file directly inside a directory. */
export async function importPath(
  deps: ImportDeps,
  request: ImportRequest,
): Promise<ImportResult[]> {
  if (!(await deps.fs.isDirectory(request.path))) {
    return [await importRecording(deps, request)];
  }
  const candidates = (await deps.fs.listFiles(request.path)).filter(
    (path) => mimeForPath(path) !== null,
  );
  if (candidates.length === 0) {
    // Not recursive by design: a media file one level deeper than
    // request.path is invisible to listFiles, and this message says so
    // rather than leaving an empty directory and a directory of nested
    // media looking the same as an unremarkable no-op.
    throw new FailureError(
      `No media files found in ${request.path}. Only files directly inside ` +
        'the directory are imported; subdirectories are not searched.',
    );
  }
  const results: ImportResult[] = [];
  for (const path of candidates) {
    results.push(await importRecording(deps, { ...request, path }));
  }
  return results;
}
