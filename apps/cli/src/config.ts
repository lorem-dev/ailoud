import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { EnvironmentError, UsageError } from '@laud/core';

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
});

export type LaudConfig = z.infer<typeof ConfigSchema>;

export interface LaudPaths {
  readonly configFile: string;
  readonly dataDir: string;
  readonly dbFile: string;
  readonly mediaRoot: string;
}

export function resolvePaths(env: Record<string, string | undefined>): LaudPaths {
  const home = env['HOME'];
  if (home === undefined || home === '') {
    throw new EnvironmentError(
      'HOME is not set, so laud cannot find its configuration or data. Set HOME in your ' +
        'shell environment, then run "laud doctor" to confirm laud is ready.',
    );
  }
  const configHome = env['XDG_CONFIG_HOME'] ?? `${home}/.config`;
  const dataHome = env['XDG_DATA_HOME'] ?? `${home}/.local/share`;
  const dataDir = `${dataHome}/laud`;
  return {
    configFile: `${configHome}/laud/config.yaml`,
    dataDir,
    dbFile: `${dataDir}/laud.db`,
    mediaRoot: `${dataDir}/media`,
  };
}

export function parseConfig(raw: string | null): LaudConfig {
  if (raw === null) return ConfigSchema.parse({});
  let document: unknown;
  try {
    document = parseYaml(raw) ?? {};
  } catch (error) {
    throw new UsageError(`The laud config file is not valid YAML: ${(error as Error).message}`);
  }
  const result = ConfigSchema.safeParse(document);
  if (!result.success) {
    const first = result.error.issues[0]!;
    throw new UsageError(`Invalid laud config at "${first.path.join('.')}": ${first.message}`);
  }
  return result.data;
}
