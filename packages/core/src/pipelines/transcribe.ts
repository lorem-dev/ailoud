import type {
  AudioTool,
  Clock,
  Fs,
  Ids,
  RecordingStore,
  SpeechSegmenter,
  TranscriptionProvider,
} from '../domain/ports.js';
import type { RawSegment, Recording, Segment, Transcript } from '../domain/model.js';
import { FailureError } from '../domain/errors.js';
import {
  mergeRuns,
  subdivideSpans,
  type DetectedSpan,
  type LanguageRun,
} from '../transcribe/merge.js';

export interface TranscribeDeps {
  readonly fs: Fs;
  readonly store: RecordingStore;
  readonly audio: AudioTool;
  readonly stt: TranscriptionProvider;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly mediaRoot: string;
  /** Only consulted when `TranscribeOptions.multilingual` is set. */
  readonly segmenter?: SpeechSegmenter;
}

export interface TranscribeOptions {
  readonly language?: string;
  readonly model?: string;
  /**
   * Segments the recording, detects each segment's language, and
   * transcribes each language run separately instead of assuming one
   * language for the whole file. Requires `TranscribeDeps.segmenter` and a
   * provider whose `capabilities.supportsLanguageDetection` is true; refuses
   * rather than silently falling back to single-language behaviour.
   */
  readonly multilingual?: boolean;
}

export async function transcribeRecording(
  deps: TranscribeDeps,
  recording: Recording,
  options: TranscribeOptions,
): Promise<Transcript> {
  if (deps.stt.capabilities.maxBytes !== null) {
    throw new FailureError(
      `${deps.stt.name} declares a request size limit, and laud cannot split audio yet. Use a provider without a limit.`,
    );
  }

  if (options.multilingual === true) {
    return transcribeMultilingual(deps, recording, options);
  }

  const tempWav = await deps.fs.tempFile('.wav');
  try {
    await deps.audio.toWav16kMono(`${deps.mediaRoot}/${recording.mediaPath}`, tempWav.path);
    const result = await deps.stt.transcribe(tempWav.path, {
      ...(options.language === undefined ? {} : { language: options.language }),
      ...(options.model === undefined ? {} : { model: options.model }),
    });

    if (result.segments.length === 0) {
      throw new FailureError(`${deps.stt.name} found no speech in ${recording.sourcePath}`);
    }

    const transcript: Transcript = {
      id: deps.ids.next(),
      recordingId: recording.id,
      provider: deps.stt.name,
      model: result.model,
      language: result.language,
      text: result.segments.map((s) => s.text).join(' '),
      createdAt: deps.clock.nowIso(),
    };

    const segments = buildSegments(deps, transcript.id, result.segments);

    await deps.store.insertTranscript(transcript, segments);
    return transcript;
  } finally {
    await tempWav.remove();
  }
}

/** Turns provider output into stored segments: assigns ids and 0-based indices. */
function buildSegments(
  deps: TranscribeDeps,
  transcriptId: string,
  raw: readonly RawSegment[],
): Segment[] {
  return raw.map((seg, idx) => ({
    id: deps.ids.next(),
    transcriptId,
    idx,
    startMs: seg.startMs,
    endMs: seg.endMs,
    text: seg.text,
    speaker: seg.speaker ?? null,
    language: seg.language ?? null,
  }));
}

/** One language run's transcription, with segment timestamps already shifted to absolute. */
interface RunOutcome {
  readonly run: LanguageRun;
  readonly model: string;
  readonly segments: RawSegment[];
}

async function transcribeMultilingual(
  deps: TranscribeDeps,
  recording: Recording,
  options: TranscribeOptions,
): Promise<Transcript> {
  if (deps.segmenter === undefined) {
    throw new FailureError(
      'multilingual transcription requires a segmenter, and none is wired up for this run.',
    );
  }
  if (!deps.stt.capabilities.supportsLanguageDetection) {
    throw new FailureError(
      `${deps.stt.name} cannot detect a language, and multilingual transcription needs a provider that can.`,
    );
  }
  // supportsLanguageDetection is true, and the port promises detectLanguage
  // is defined whenever that capability is; a provider violating its own
  // contract is a provider bug, not a recoverable user error. Bind it to
  // deps.stt now: a bare reference to a method loses its `this` when called
  // later, and providers are free to rely on instance state.
  if (deps.stt.detectLanguage === undefined) {
    throw new Error(
      `${deps.stt.name} declares supportsLanguageDetection but has no detectLanguage`,
    );
  }
  const detectLanguage = deps.stt.detectLanguage.bind(deps.stt);

  const segmenter = deps.segmenter;

  const tempWav = await deps.fs.tempFile('.wav');
  try {
    await deps.audio.toWav16kMono(`${deps.mediaRoot}/${recording.mediaPath}`, tempWav.path);

    const spans = await segmenter.segments(tempWav.path);
    const windows = subdivideSpans(spans);

    const detected: DetectedSpan[] = [];
    for (const window of windows) {
      const slice = await deps.fs.tempFile('.wav');
      try {
        await deps.audio.slice(tempWav.path, slice.path, window.startMs, window.endMs);
        const language = await detectLanguage(slice.path);
        detected.push({ ...window, language });
      } finally {
        await slice.remove();
      }
    }

    const runs = mergeRuns(detected);
    if (runs.length === 0) {
      throw new FailureError(`${deps.stt.name} found no speech in ${recording.sourcePath}`);
    }

    const outcomes: RunOutcome[] = [];
    for (const run of runs) {
      const slice = await deps.fs.tempFile('.wav');
      try {
        await deps.audio.slice(tempWav.path, slice.path, run.startMs, run.endMs);
        const result = await deps.stt.transcribe(slice.path, {
          language: run.language,
          ...(options.model === undefined ? {} : { model: options.model }),
        });
        outcomes.push({
          run,
          model: result.model,
          // The run's own transcription starts its timestamps at zero:
          // whisper only ever saw this slice. Shift back into the
          // recording's absolute timeline before anything is stored, and
          // stamp the run's own (forced, known) language onto each segment
          // rather than trusting whatever the provider echoes back.
          segments: result.segments.map((seg) => ({
            ...seg,
            startMs: seg.startMs + run.startMs,
            endMs: seg.endMs + run.startMs,
            language: run.language,
          })),
        });
      } finally {
        await slice.remove();
      }
    }

    const allSegments = outcomes.flatMap((o) => o.segments);
    if (allSegments.length === 0) {
      throw new FailureError(`${deps.stt.name} found no speech in ${recording.sourcePath}`);
    }

    // The file has no single language; the longest run by duration is the
    // least wrong answer for a column that must hold one value. Strictly
    // greater-than, deliberately: a tie keeps whichever run was seen first,
    // i.e. the earlier one in the recording. Any tie-break is arbitrary, so
    // the simplest one was chosen rather than left as an accident.
    let longest = outcomes[0]!;
    for (const outcome of outcomes) {
      const duration = outcome.run.endMs - outcome.run.startMs;
      const longestDuration = longest.run.endMs - longest.run.startMs;
      if (duration > longestDuration) longest = outcome;
    }

    const transcript: Transcript = {
      id: deps.ids.next(),
      recordingId: recording.id,
      provider: deps.stt.name,
      model: longest.model,
      language: longest.run.language,
      text: allSegments.map((s) => s.text).join(' '),
      createdAt: deps.clock.nowIso(),
    };

    const segments = buildSegments(deps, transcript.id, allSegments);

    await deps.store.insertTranscript(transcript, segments);
    return transcript;
  } finally {
    await tempWav.remove();
  }
}
