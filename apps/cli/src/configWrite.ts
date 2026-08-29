import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseDocument } from 'yaml';

export interface ConfigUpdates {
  readonly model?: string;
  readonly vadModel?: string;
  readonly binary?: string;
  readonly vadBinary?: string;
}

/**
 * Sets the given keys in a config file's text, leaving everything else as it
 * was found.
 *
 * Uses the yaml document API (parseDocument/setIn/toString) rather than
 * parse-to-object-and-dump: the latter would silently strip every comment and
 * reorder every key in a file the user hand-wrote. An installer editing
 * someone's configuration should leave no trace beyond the lines it came to
 * change.
 *
 * Pure -- string in, string out -- so the merge rules are unit tested without
 * a filesystem.
 */
export function applyConfigUpdates(source: string | null, updates: ConfigUpdates): string {
  const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return source ?? '';

  // parseDocument('') still yields a document whose setIn can create the
  // missing nested path (verified against yaml 2.9.0, the version pinned in
  // apps/cli/package.json), so no '{}' seed is needed here.
  const doc = parseDocument(source ?? '');
  for (const [key, value] of entries) {
    doc.setIn(['stt', 'whisperCpp', key], value);
  }
  return doc.toString();
}

async function readConfigFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null; // no config file is the normal first run, not an error
  }
}

/** Reads, applies, and writes back. Creates the file and its directory if absent. */
export async function writeConfigUpdates(
  configFile: string,
  updates: ConfigUpdates,
): Promise<void> {
  const source = await readConfigFile(configFile);
  const next = applyConfigUpdates(source, updates);
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, next, 'utf8');
}
