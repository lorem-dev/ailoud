import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { EnvironmentError, LLM_PROVIDERS, UsageError } from '@ailoud/core';

// Zod 4's `.default()` short-circuits: when the key is missing it substitutes
// the default value as-is, without re-running it through the inner schema.
// For a nested object default that means the inner keys' own defaults never
// fire and a partial config file loses the fields it did not mention. This
// contradicts the requirement that `.default({})` fills in the rest, so
// nested objects use `.prefault()` instead, which re-parses the default
// value through the inner schema (the pre-Zod-4 `.default()` behaviour).
const ConfigSchema = z.object({
  stt: z
    .object({
      provider: z.enum(['whisper-cpp']).default('whisper-cpp'),
      whisperCpp: z
        .object({
          binary: z.string().default('whisper-cli'),
          model: z.string().nullable().default(null),
          vadBinary: z.string().default('whisper-vad-speech-segments'),
          vadModel: z.string().nullable().default(null),
        })
        .prefault({}),
      diarization: z
        .object({
          binary: z.string().default('sherpa-onnx-offline-speaker-diarization'),
          segmentationModel: z.string().nullable().default(null),
          embeddingModel: z.string().nullable().default(null),
          threshold: z.number().default(0.6),
          // Threads for both diarizer passes (segmentation and embedding).
          // The binary itself defaults to 1, which halves the throughput the
          // design measured and the README quotes: 16 s of audio in 2.58 s on
          // one thread against 57 s in 5.19 s on four. Four is the default
          // here because it is the configuration those numbers were taken on,
          // and because any machine that can run a 465 MB whisper model has
          // four cores. Configurable rather than baked into the adapter: a
          // 2-core VM wants fewer, and a workstation transcribing a long
          // meeting wants more.
          threads: z.number().int().min(1).default(4),
        })
        .prefault({}),
    })
    .prefault({}),
  llm: z
    .object({
      // From core's list, not a second copy of it: a provisioning remedy names
      // a provider, and the two drifting apart would let setup write one this
      // schema then refuses to parse.
      provider: z.enum(LLM_PROVIDERS).default('llama-cpp'),
      llamaCpp: z
        .object({
          binary: z.string().default('llama-cli'),
          model: z.string().nullable().default(null),
          contextTokens: z.number().int().min(512).default(8192),
          maxOutputTokens: z.number().int().min(64).default(1024),
          threads: z.number().int().min(1).default(4),
        })
        .prefault({}),
      openaiCompatible: z
        .object({
          baseUrl: z.string().default('https://api.openai.com/v1'),
          model: z.string().default('gpt-4o-mini'),
          contextTokens: z.number().int().min(512).default(128_000),
          maxOutputTokens: z.number().int().min(64).default(1024),
        })
        .prefault({}),
      anthropic: z
        .object({
          baseUrl: z.string().default('https://api.anthropic.com/v1'),
          model: z.string().default('claude-sonnet-5'),
          contextTokens: z.number().int().min(512).default(200_000),
          maxOutputTokens: z.number().int().min(64).default(2048),
        })
        .prefault({}),
      claudeCli: z
        .object({
          binary: z.string().default('claude'),
          // A Claude Code alias rather than a pinned id: the alias follows
          // the newest model of that tier, which is what someone paying for a
          // subscription wants without editing config every release.
          model: z.string().default('sonnet'),
          contextTokens: z.number().int().min(512).default(200_000),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type AiloudConfig = z.infer<typeof ConfigSchema>;

export interface AiloudPaths {
  readonly configFile: string;
  readonly dataDir: string;
  readonly dbFile: string;
  readonly mediaRoot: string;
  /** True when the library came from a project's `.ailoud/`, not the user's home. */
  readonly isProjectLibrary: boolean;
}

/** The directory name a project uses to keep its own library. */
export const PROJECT_DIR = '.ailoud';

/**
 * The nearest `.ailoud/` at or above `from`, or null.
 *
 * Walked upwards rather than checked only in the current directory, for the
 * same reason git looks upwards for `.git`: work happens in subdirectories,
 * and a library that appeared and vanished depending on which one you were
 * standing in would be worse than no feature at all.
 *
 * Takes an existence predicate rather than touching the filesystem, so the
 * search is testable and so this module keeps doing no I/O of its own.
 */
export function findProjectDir(from: string, exists: (path: string) => boolean): string | null {
  let at = from;
  for (;;) {
    const candidate = `${at}/${PROJECT_DIR}`;
    if (exists(candidate)) return candidate;
    const parent = at.replace(/\/[^/]*$/, '');
    if (parent === at || parent === '') return null;
    at = parent;
  }
}

export interface ResolvePathsOptions {
  /** Where to start looking for a project library. Absent means: do not look. */
  readonly cwd?: string;
  readonly exists?: (path: string) => boolean;
}

/**
 * Where the configuration and the library live.
 *
 * The library is per-project when a `.ailoud/` directory exists at or above
 * the working directory, and per-user otherwise. Recordings belong to the work
 * they came from -- a repository's design reviews are not the same collection
 * as last year's personal voice notes -- and a project directory is how that
 * is said, the same way `.codegraph/` says it for an index.
 *
 * The CONFIG stays per-user either way. It names installed binaries, model
 * files and an LLM provider, none of which is a property of a project, and
 * making it local would mean re-downloading a 488 MB model per repository.
 */
export function resolvePaths(
  env: Record<string, string | undefined>,
  options: ResolvePathsOptions = {},
): AiloudPaths {
  const home = env['HOME'];
  if (home === undefined || home === '') {
    throw new EnvironmentError(
      'HOME is not set, so ailoud cannot find its configuration or data. Set HOME in your ' +
        'shell environment, then run "ailoud doctor" to confirm ailoud is ready.',
    );
  }
  const configHome = env['XDG_CONFIG_HOME'] ?? `${home}/.config`;
  const dataHome = env['XDG_DATA_HOME'] ?? `${home}/.local/share`;

  const project =
    options.cwd === undefined || options.exists === undefined
      ? null
      : findProjectDir(options.cwd, options.exists);
  const dataDir = project ?? `${dataHome}/ailoud`;

  return {
    configFile: `${configHome}/ailoud/config.yaml`,
    dataDir,
    dbFile: `${dataDir}/ailoud.db`,
    mediaRoot: `${dataDir}/media`,
    isProjectLibrary: project !== null,
  };
}

export function parseConfig(raw: string | null): AiloudConfig {
  if (raw === null) return ConfigSchema.parse({});
  let document: unknown;
  try {
    document = parseYaml(raw) ?? {};
  } catch (error) {
    throw new UsageError(`The ailoud config file is not valid YAML: ${(error as Error).message}`);
  }
  const result = ConfigSchema.safeParse(document);
  if (!result.success) {
    const first = result.error.issues[0]!;
    throw new UsageError(`Invalid ailoud config at "${first.path.join('.')}": ${first.message}`);
  }
  return result.data;
}
