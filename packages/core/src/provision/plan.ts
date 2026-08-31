import { UsageError } from '../domain/errors.js';
import type { ModelChoice } from './catalogue.js';
import {
  EMBEDDING_MODEL,
  LANGUAGE_MODEL,
  SEGMENTATION_MODEL,
  VAD_MODEL,
  findModel,
} from './catalogue.js';
import type { Remedy } from './remedy.js';

/** A remedy with everything needed to execute it resolved. */
export type Action =
  | { readonly kind: 'install-ffmpeg' }
  | { readonly kind: 'install-whisper' }
  | { readonly kind: 'install-diarizer' }
  | { readonly kind: 'install-llm' }
  | { readonly kind: 'download-llm-model'; readonly model: ModelChoice }
  | {
      readonly kind: 'download-model';
      readonly slot: 'transcription' | 'vad';
      readonly model: ModelChoice;
    }
  | {
      readonly kind: 'download-diarization-model';
      readonly slot: 'segmentation' | 'embedding';
      readonly model: ModelChoice;
    }
  | { readonly kind: 'create-directory'; readonly path: string };

export interface PlanOptions {
  readonly modelName: string;
}

/**
 * Directories before binaries before models. The order matters: the media
 * root must exist before anything writes near it, and the whisper/diarizer
 * binaries should land before the models they will be checked against, so
 * that a re-check after a partial run reports the more useful failure. The
 * diarizer binary and its models sit right beside their whisper equivalents,
 * for the same reason.
 */
const ORDER = [
  'create-directory',
  'install-ffmpeg',
  'install-whisper',
  'install-diarizer',
  'install-llm',
  'download-model',
  'download-llm-model',
  'download-diarization-model',
] satisfies readonly Action['kind'][];

/** Two remedies are the same job when this key matches. */
function keyOf(remedy: Remedy): string {
  switch (remedy.kind) {
    case 'install-llm':
      return 'install-llm';
    case 'download-llm-model':
      return 'download-llm-model';
    case 'create-directory':
      return `create-directory:${remedy.path}`;
    case 'install-ffmpeg':
      return 'install-ffmpeg';
    case 'install-whisper':
      return 'install-whisper';
    case 'install-diarizer':
      return 'install-diarizer';
    case 'download-model':
      return `download-model:${remedy.slot}`;
    case 'download-diarization-model':
      // Slot included on purpose: segmentation and embedding are two
      // genuinely different downloads, and without the slot they would
      // collapse into a single deduplicated action the way two identical
      // install-ffmpeg remedies are supposed to.
      return `download-diarization-model:${remedy.slot}`;
  }
}

function resolve(remedy: Remedy, options: PlanOptions): Action {
  if (remedy.kind === 'download-model') {
    if (remedy.slot === 'vad') return { ...remedy, model: VAD_MODEL };
    const model = findModel(options.modelName);
    if (model === undefined) {
      throw new UsageError(
        `unknown model "${options.modelName}"; run "laud setup" without --model to choose one`,
      );
    }
    return { ...remedy, model };
  }
  if (remedy.kind === 'download-diarization-model') {
    const model = remedy.slot === 'segmentation' ? SEGMENTATION_MODEL : EMBEDDING_MODEL;
    return { ...remedy, model };
  }
  if (remedy.kind === 'download-llm-model') return { ...remedy, model: LANGUAGE_MODEL };
  return remedy;
}

/**
 * Turns the remedies of failing checks into an ordered, deduplicated action
 * list. Pure: it decides WHAT to do, never does it. Callers pass only the
 * remedies they want acted on, which is the whole difference between `setup`
 * (everything missing) and `doctor --fix` (only what failed) -- the
 * restriction is an input here, not a second code path.
 */
export function planProvisioning(
  remedies: readonly Remedy[],
  options: PlanOptions,
): readonly Action[] {
  const unique = new Map<string, Remedy>();
  for (const remedy of remedies) {
    const key = keyOf(remedy);
    if (!unique.has(key)) unique.set(key, remedy);
  }
  return [...unique.values()]
    .map((remedy) => resolve(remedy, options))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/** Total bytes the plan will download, for the confirmation prompt. */
export function planDownloadBytes(actions: readonly Action[]): number {
  return actions.reduce(
    (total, action) =>
      action.kind === 'download-model' || action.kind === 'download-diarization-model'
        ? total + action.model.bytes
        : total,
    0,
  );
}
