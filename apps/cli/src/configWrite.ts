import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseDocument } from 'yaml';
import { UsageError } from '@laud/core';

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
 * a filesystem. Throws (and writes nothing) if `source` is not valid YAML, or
 * if `stt` or `stt.whisperCpp` already exists as something other than a
 * mapping -- both are the safe direction, since guessing how to reshape a
 * hand-written file could destroy whatever was there.
 */
export function applyConfigUpdates(source: string | null, updates: ConfigUpdates): string {
  const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return source ?? '';

  // parseDocument('') still yields a document whose setIn can create the
  // missing nested path (verified against yaml 2.9.0, the version pinned in
  // apps/cli/package.json), so no '{}' seed is needed here.
  const doc = parseDocument(source ?? '');
  for (const [key, value] of entries) {
    try {
      doc.setIn(['stt', 'whisperCpp', key], value);
    } catch {
      // yaml's own message here ("Expected YAML collection at stt") assumes
      // familiarity with the document API; name the config key instead so
      // someone editing the file by hand knows what to fix.
      throw new UsageError(
        `Cannot set "stt.whisperCpp.${key}": "stt" or "stt.whisperCpp" in the existing ` +
          `config is not a mapping. Fix that section by hand and try again.`,
      );
    }
  }
  // A source with unrelated parse errors (e.g. a stray unclosed bracket
  // elsewhere in the file) can still accept the setIn calls above -- the
  // broken part and the path being edited are different nodes -- but
  // toString() refuses to serialize a document that carries parse errors.
  // That is exactly the property this function relies on to never turn a
  // file someone is mid-edit on into a worse, differently-broken file.
  //
  // Rewrapped for the same reason the setIn failure above is: yaml's own
  // "Document with errors cannot be stringified" names neither the file nor
  // the problem, and this is reached after a download of up to 1.6 GB, so
  // it is the last message the user gets and has to be actionable on its own.
  try {
    return doc.toString();
  } catch {
    throw new UsageError(
      `Cannot record the installed paths: the existing config is not valid YAML ` +
        `(${describeParseErrors(doc.errors)}). Fix the file by hand, then re-run -- ` +
        'nothing already downloaded is lost, laud will skip it.',
    );
  }
}

/** The parse problem, in the user's words rather than the yaml package's. */
function describeParseErrors(errors: readonly { readonly message: string }[]): string {
  const first = errors[0];
  if (first === undefined) return 'it could not be serialized';
  return errors.length > 1 ? `${first.message}; and ${errors.length - 1} more` : first.message;
}

/** True for the one read failure that legitimately means "no config file yet". */
function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readConfigFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null; // no config file is the normal first run, not an error
    throw error; // permission-denied and friends are real errors, not "missing"
  }
}

/**
 * Reads, applies, and writes back. Creates the file and its directory if
 * absent.
 *
 * Writes to `<configFile>.tmp` and renames onto the target rather than
 * writing the target directly, the same way packages/providers's
 * download.ts writes models: rename within a directory is atomic, so a
 * process killed mid-write leaves the previous config intact instead of a
 * truncated one. This is a file a human hand-edits; there is no
 * acceptable version of "the installer half-wrote your config".
 */
export async function writeConfigUpdates(
  configFile: string,
  updates: ConfigUpdates,
): Promise<void> {
  const source = await readConfigFile(configFile);

  let next: string;
  try {
    next = applyConfigUpdates(source, updates);
  } catch (error) {
    if (error instanceof UsageError) {
      throw new UsageError(`${configFile}: ${error.message}`);
    }
    throw error;
  }

  await mkdir(dirname(configFile), { recursive: true });
  const tempFile = `${configFile}.tmp`;
  try {
    await writeFile(tempFile, next, 'utf8');
    await rename(tempFile, configFile);
  } catch (error) {
    try {
      await rm(tempFile, { force: true });
    } catch {
      // Cleanup failing must not replace the original error -- that
      // original is the whole reason this function exists: the disk-full
      // or permission problem that explains why the config was not
      // updated. A user seeing an unlink error instead would have no idea
      // their write actually failed.
    }
    throw error;
  }
}
