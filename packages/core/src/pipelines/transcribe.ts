import type {
  AudioTool,
  Clock,
  Fs,
  Ids,
  RecordingStore,
  TranscriptionProvider,
} from '../domain/ports.js';
import type { Recording, Segment, Transcript } from '../domain/model.js';
import { FailureError } from '../domain/errors.js';

export interface TranscribeDeps {
  readonly fs: Fs;
  readonly store: RecordingStore;
  readonly audio: AudioTool;
  readonly stt: TranscriptionProvider;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly mediaRoot: string;
}

export interface TranscribeOptions {
  readonly language?: string;
  readonly model?: string;
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

    const segments: Segment[] = result.segments.map((raw, idx) => ({
      id: deps.ids.next(),
      transcriptId: transcript.id,
      idx,
      startMs: raw.startMs,
      endMs: raw.endMs,
      text: raw.text,
      speaker: raw.speaker ?? null,
      language: raw.language ?? null,
    }));

    await deps.store.insertTranscript(transcript, segments);
    return transcript;
  } finally {
    await tempWav.remove();
  }
}
