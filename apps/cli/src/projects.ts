import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Clock, Fs } from '@ailoud/core';

/** One project ailoud has been used in, as remembered across runs. */
export interface ProjectEntry {
  readonly path: string;
  readonly libraryDir?: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly rulesVersion?: string;
}

export interface ProjectsDeps {
  readonly fs: Fs;
  readonly clock: Clock;
  /**
   * The per-user data directory (`AiloudPaths.userDataDir`), never
   * `AiloudPaths.dataDir`. `dataDir` follows the current project's `.ailoud/`
   * when there is one, and a registry stored inside one project would only
   * ever list that project.
   */
  readonly userDataDir: string;
}

/** How long a registration is left untouched before a re-run bumps `lastSeen` again. */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

const ProjectEntrySchema = z.object({
  path: z.string(),
  libraryDir: z.string().optional(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  rulesVersion: z.string().optional(),
});

const RegistrySchema = z.array(ProjectEntrySchema);

export function registryPath(userDataDir: string): string {
  return `${userDataDir}/projects.json`;
}

/** Where a registry that failed to parse is moved, so it never blocks a run. */
function quarantinePath(userDataDir: string): string {
  return `${userDataDir}/projects.json.bad`;
}

/**
 * Writes the registry atomically: a temporary file beside the real one, then
 * a rename over the top. Two `ailoud` processes can register a project at
 * the same moment; writing in place would let a reader see a half-written
 * file. The temporary file's name is randomised per call so two concurrent
 * writers never share -- and corrupt -- the same temporary file; the worst
 * case is that one writer's rename wins and the other's `lastSeen` bump is
 * lost, which is acceptable.
 */
async function writeRegistry(deps: ProjectsDeps, entries: readonly ProjectEntry[]): Promise<void> {
  const path = registryPath(deps.userDataDir);
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await deps.fs.ensureDir(deps.userDataDir);
  await deps.fs.writeTextFile(tempPath, `${JSON.stringify(entries, null, 2)}\n`);
  await deps.fs.rename(tempPath, path);
}

/**
 * Every project ailoud has been used in.
 *
 * A registry is a convenience, not a source of truth: a file that fails to
 * parse must never fail the command that asked for it. It is instead moved
 * aside to `projects.json.bad` so a human can look at it, and reading
 * proceeds as though there were no registry yet.
 */
export async function readProjects(deps: ProjectsDeps): Promise<readonly ProjectEntry[]> {
  const path = registryPath(deps.userDataDir);
  if (!(await deps.fs.exists(path))) return [];

  const raw = await deps.fs.readTextFile(path);
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    await deps.fs.rename(path, quarantinePath(deps.userDataDir));
    return [];
  }

  const result = RegistrySchema.safeParse(document);
  if (!result.success) {
    await deps.fs.rename(path, quarantinePath(deps.userDataDir));
    return [];
  }
  return result.data;
}

/**
 * Records that a project was just used, creating the registry on first use.
 *
 * Skips the write when the project was already seen within the last 24
 * hours: the hot path is a command that touches a project library reading
 * this file on every run, and writing on every run would put a disk write on
 * something as routine as `ailoud ls`. `rulesVersion` is the exception --
 * when it is given, rules were just written to the project, which is worth
 * recording immediately rather than waiting out the throttle.
 */
export async function rememberProject(
  deps: ProjectsDeps,
  project: { path: string; libraryDir?: string; rulesVersion?: string },
): Promise<void> {
  const projects = await readProjects(deps);
  const now = deps.clock.nowIso();
  const index = projects.findIndex((entry) => entry.path === project.path);

  if (index === -1) {
    const entry: ProjectEntry = {
      path: project.path,
      firstSeen: now,
      lastSeen: now,
      ...(project.libraryDir === undefined ? {} : { libraryDir: project.libraryDir }),
      ...(project.rulesVersion === undefined ? {} : { rulesVersion: project.rulesVersion }),
    };
    await writeRegistry(deps, [...projects, entry]);
    return;
  }

  const existing = projects[index]!;
  const staleMs = Date.parse(now) - Date.parse(existing.lastSeen);
  const rulesJustWritten = project.rulesVersion !== undefined;
  if (staleMs < REFRESH_AFTER_MS && !rulesJustWritten) return;

  const updated: ProjectEntry = {
    ...existing,
    lastSeen: now,
    ...(project.libraryDir === undefined ? {} : { libraryDir: project.libraryDir }),
    ...(project.rulesVersion === undefined ? {} : { rulesVersion: project.rulesVersion }),
  };
  const next = [...projects];
  next[index] = updated;
  await writeRegistry(deps, next);
}

/**
 * Drops entries whose project directory is gone, and returns what was
 * dropped so the caller can report it.
 *
 * Checked against `entry.path` itself, not a `.ailoud/` beneath it: a project
 * whose library is gone can still hold the rules block sync exists to
 * refresh, so losing the library is not reason enough to forget the project.
 * Never removes anything on disk -- only the registry file is rewritten, and
 * only when there is something to drop.
 */
export async function pruneProjects(deps: ProjectsDeps): Promise<readonly ProjectEntry[]> {
  const projects = await readProjects(deps);
  const kept: ProjectEntry[] = [];
  const dropped: ProjectEntry[] = [];
  for (const entry of projects) {
    if (await deps.fs.isDirectory(entry.path)) kept.push(entry);
    else dropped.push(entry);
  }
  if (dropped.length > 0) await writeRegistry(deps, kept);
  return dropped;
}
