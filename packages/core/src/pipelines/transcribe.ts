import type {
  AudioTool,
  Clock,
  Diarizer,
  Fs,
  Ids,
  RecordingStore,
  SpeakerTurn,
  SpeechSegmenter,
  SpeechSpan,
  TranscriptionProvider,
} from '../domain/ports.js';
import type { RawSegment, Recording, Segment, Transcript } from '../domain/model.js';
import { FailureError } from '../domain/errors.js';
import { assignSpeakers } from '../diarize/assign.js';
import {
  detectionWindowMs,
  mergeRuns,
  resolveDeclaredLanguages,
  subdivideSpans,
  type DetectedSpan,
  type LanguageRun,
} from '../transcribe/merge.js';
import { resolveBySpeaker } from '../transcribe/bySpeaker.js';

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
  /** Only consulted when `TranscribeOptions.diarize` is set. */
  readonly diarizer?: Diarizer;
  /**
   * Reports non-fatal problems, e.g. a diarizer that failed. Core does no
   * I/O of its own, so the CLI supplies the sink (routed to `ui`); left
   * unset, such problems are simply not reported.
   */
  readonly onWarning?: (message: string) => void;
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
  /**
   * The languages the caller knows are present. Only meaningful alongside
   * `multilingual`.
   *
   * whisper's detector answers with any language in the world and cannot be
   * restricted, so on a Russian/English recording it will sometimes report
   * Polish for a Russian stretch -- and that stretch is then transcribed as
   * Polish, coming back as phonetic nonsense. Declaring the set turns that
   * answer from a discovery into a knowable mis-detection; see
   * `resolveDeclaredLanguages`. Empty means nothing was declared and every
   * detection is taken at face value.
   */
  readonly declaredLanguages?: readonly string[];
  /**
   * Runs speaker diarization over the recording and attributes each
   * transcribed segment to a speaker by time overlap. Requires
   * `TranscribeDeps.diarizer`.
   */
  readonly diarize?: true;
  /** Hint for the diarizer: the known number of speakers, when known. */
  readonly speakers?: number;
}

/**
 * Speakers are an enrichment, never a precondition. A diarizer that is
 * missing, crashes, or emits nothing parseable must cost the caller their
 * speaker labels and nothing else -- losing an expensive transcription to a
 * failed extra is the worst trade available here.
 *
 * Every outcome in which `diarize` was asked for and no speaker was
 * attributed warns, not just the one where the diarizer throws. Without that
 * a `--diarize` run whose diarizer was never wired up, or whose binary exited
 * cleanly having recognized nothing, produces output byte-identical to a
 * plain run and exits 0 -- the user is told they got speakers when they did
 * not. Section 5.7 of the diarization design names the "emits nothing
 * parseable" case explicitly.
 */
/**
 * Speaker turns for use as detection units, or nothing.
 *
 * Never throws, for the same reason withSpeakers does not: the diarizer is an
 * enrichment here too. If it is missing or fails, the run falls back to the
 * segmenter's spans and still produces a transcript -- losing the better
 * segmentation, not the words.
 *
 * The turns are fetched once and used twice: here to decide what to detect
 * language on, and later by withSpeakers to label the segments. Running the
 * diarizer twice over the same audio would double the cost for one answer.
 */
async function diarizeQuietly(
  deps: TranscribeDeps,
  options: TranscribeOptions,
  wavPath: string,
): Promise<readonly SpeakerTurn[]> {
  if (deps.diarizer === undefined) return [];
  try {
    return await deps.diarizer.turns(wavPath, {
      ...(options.speakers === undefined ? {} : { speakers: options.speakers }),
    });
  } catch (error) {
    deps.onWarning?.(
      `speaker diarization failed, so language detection fell back to speech segmentation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

async function withSpeakers(
  deps: TranscribeDeps,
  options: TranscribeOptions,
  wavPath: string,
  segments: readonly RawSegment[],
  /**
   * Turns already fetched by the caller, reused rather than asked for again.
   * The multilingual path needs them earlier, to decide what to detect
   * language on, and diarizing the same audio twice would double the cost
   * for one answer. Empty means "not fetched yet, go and get them".
   */
  alreadyFetched: readonly SpeakerTurn[] = [],
): Promise<RawSegment[]> {
  if (options.diarize !== true) return [...segments];
  if (alreadyFetched.length > 0) {
    try {
      return assignSpeakers(segments, alreadyFetched);
    } catch (error) {
      deps.onWarning?.(
        `assigning speakers failed, so this transcript has no speakers: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [...segments];
    }
  }
  if (deps.diarizer === undefined) {
    // Unreachable from the CLI: `CliContext.createDiarizer()` is
    // non-nullable, so `--diarize` either yields a diarizer or throws an
    // EnvironmentError naming the unconfigured model. Kept as a guard for
    // library callers, who can build deps without one -- and it must warn
    // rather than throw, because the transcript is already worth keeping.
    //
    // Names no install command on purpose. `laud setup` and `laud doctor
    // --fix` both refuse Windows, so naming them here would rebuild the same
    // dead end checkDiarizerBinary's fix text was just cured of (see
    // installHint in ../provision/remedy.ts). `laud doctor` is safe on every
    // platform and reports the per-platform remedy itself.
    deps.onWarning?.(
      'speaker diarization was requested but no diarizer is available, so this transcript ' +
        'has no speakers. Run "laud doctor" to see which diarization pieces are missing.',
    );
    return [...segments];
  }

  // Only the call that can genuinely fail lives inside the try -- the
  // diarizer, and nothing else. A warning raised in here would be
  // caught below, relabelled as "diarization failed" against the sink's own
  // error rather than the real cause, and rethrown out of withSpeakers --
  // taking the finished transcription with it. Keeping every onWarning call
  // outside makes "withSpeakers cannot throw" true by structure instead of
  // by an argument about what a sink happens to do.
  let turns: readonly SpeakerTurn[];
  try {
    turns = await deps.diarizer.turns(wavPath, {
      ...(options.speakers === undefined ? {} : { speakers: options.speakers }),
    });
  } catch (error) {
    deps.onWarning?.(
      `speaker diarization failed, so this transcript has no speakers: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [...segments];
  }

  if (turns.length === 0) {
    // The binary can exit 0 having emitted nothing this side can parse --
    // too little speech to cluster, or output in a shape the adapter's
    // parser does not recognize. assignSpeakers on an empty turn list is
    // a no-op, so without this branch the run is silent and indetectable.
    deps.onWarning?.(
      'speaker diarization found no speaker turns, so this transcript has no speakers. ' +
        'Passing --speakers <n> is more reliable than letting the count be inferred; ' +
        'a lower "stt.diarization.threshold" also splits more readily.',
    );
    return [...segments];
  }
  try {
    return assignSpeakers(segments, turns);
  } catch (error) {
    // assignSpeakers is pure arithmetic over typed spans and has no realistic
    // way to throw, but the guarantee this function offers its callers -- that
    // a diarization problem costs speaker labels and nothing else -- is worth
    // holding by structure rather than by an argument about what pure code
    // happens to do. Every escape hatch above returns the segments unchanged;
    // so does this one.
    deps.onWarning?.(
      `assigning speakers failed, so this transcript has no speakers: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [...segments];
  }
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

    // One diarizer pass over the whole recording, on the same full-recording
    // wav the transcript just came from -- before tempWav.remove() runs in
    // this try's finally.
    const withSpeakerLabels = await withSpeakers(deps, options, tempWav.path, result.segments);

    const transcript: Transcript = {
      id: deps.ids.next(),
      recordingId: recording.id,
      provider: deps.stt.name,
      model: result.model,
      language: result.language,
      text: withSpeakerLabels.map((s) => s.text).join(' '),
      createdAt: deps.clock.nowIso(),
    };

    const segments = buildSegments(deps, transcript.id, withSpeakerLabels);

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

    const declared = options.declaredLanguages ?? [];

    // Speaker turns are better detection units than windows cut from speech
    // spans, when they are available: they are the boundaries language
    // actually changes on in a bilingual exchange, and pooling a speaker's
    // turns gives detection far more audio to judge by than any one turn
    // does. See resolveBySpeaker. Falls back to the segmenter when no
    // diarizer was wired up, which is every run without --diarize.
    const speakerTurns =
      options.diarize === true && deps.diarizer !== undefined
        ? await diarizeQuietly(deps, options, tempWav.path)
        : [];

    const units: readonly (SpeechSpan & { readonly speaker?: string })[] =
      speakerTurns.length > 0
        ? speakerTurns
        : subdivideSpans(
            await segmenter.segments(tempWav.path),
            detectionWindowMs(declared.length),
          );

    const detected: (DetectedSpan & { speaker?: string })[] = [];
    for (const unit of units) {
      const slice = await deps.fs.tempFile('.wav');
      try {
        await deps.audio.slice(tempWav.path, slice.path, unit.startMs, unit.endMs);
        const language = await detectLanguage(slice.path, {
          ...(options.model === undefined ? {} : { model: options.model }),
        });
        detected.push({ ...unit, language });
      } finally {
        await slice.remove();
      }
    }

    // Resolved before merging, not after: mergeRuns groups by language, so a
    // unit still carrying a mis-detected language would split a run that
    // should have been continuous -- which is how the first half of a phrase
    // ends up transcribed in the wrong language and lost.
    //
    // With speaker labels the resolution is per speaker (their own turns
    // outvote a bad one); without them it can only be per declared set.
    const resolved =
      speakerTurns.length > 0
        ? resolveBySpeaker(
            detected.map((unit) => ({ ...unit, speaker: unit.speaker ?? '' })),
            declared,
          )
        : resolveDeclaredLanguages(detected, declared);
    const runs = mergeRuns(resolved);
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

    // Every run's segments are already shifted onto the recording's absolute
    // timeline (see the comment above), so one diarizer pass over the whole
    // wav -- not one per run -- lines up with all of them at once.
    const withSpeakerLabels = await withSpeakers(
      deps,
      options,
      tempWav.path,
      allSegments,
      speakerTurns,
    );

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
      text: withSpeakerLabels.map((s) => s.text).join(' '),
      createdAt: deps.clock.nowIso(),
    };

    const segments = buildSegments(deps, transcript.id, withSpeakerLabels);

    await deps.store.insertTranscript(transcript, segments);
    return transcript;
  } finally {
    await tempWav.remove();
  }
}
