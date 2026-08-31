import { describe, expect, it } from 'vitest';
import type { Recording, Segment, SpeakerName } from '../domain/model.js';
import { transcriptFileHeader, transcriptFileName, transcriptFileStem } from './transcriptFile.js';

const recording = (over: Partial<Recording> = {}): Recording => ({
  id: 'ID001',
  sha256: 'x',
  sourcePath: '/in/standup.m4a',
  mediaPath: '/lib/standup.m4a',
  durationMs: 1000,
  mime: 'audio/mp4',
  title: null,
  notes: null,
  recordedAt: '2026-08-24T09:30:15.000Z',
  importedAt: '2026-08-30T12:00:00.000Z',
  ...over,
});

const segment = (speaker: string | null): Segment =>
  ({
    id: 's',
    transcriptId: 't',
    idx: 0,
    startMs: 0,
    endMs: 1,
    text: 'hi',
    speaker,
    language: 'en',
  }) as Segment;

describe('transcriptFileStem', () => {
  it('carries the recording date, so the name answers "which meeting" on its own', () => {
    const at = new Date('2026-08-24T09:30:15.000Z');
    const pad = (n: number) => String(n).padStart(2, '0');
    // Local time, matching the header and every other date laud prints.
    const expected =
      `record-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
      `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
    expect(transcriptFileStem(recording())).toBe(expected);
  });

  it('falls back to the import date when the audio carried none', () => {
    // Asserted by date rather than by hour: the stem is local time, and the
    // suite must not fail in another timezone.
    expect(transcriptFileStem(recording({ recordedAt: null }))).toMatch(/^record-20260830\d{6}$/);
  });

  it('falls back to the id rather than emitting NaN for an unparseable date', () => {
    expect(transcriptFileStem(recording({ recordedAt: 'not a date' }))).toBe('record-ID001');
  });
});

describe('transcriptFileName', () => {
  it('leaves the common case unadorned', () => {
    expect(transcriptFileName(recording(), new Set())).toMatch(/^record-\d{14}\.txt$/);
  });

  it('suffixes a collision instead of overwriting a whole meeting', () => {
    // Two recordings can share a second: a split file, or a bulk import whose
    // metadata all carries one timestamp.
    const taken = new Set<string>();
    const first = transcriptFileName(recording(), taken);
    taken.add(first);
    const second = transcriptFileName(recording({ id: 'ID002' }), taken);
    expect(second).not.toBe(first);
    expect(second).toMatch(/-001\.txt$/);
    taken.add(second);
    expect(transcriptFileName(recording({ id: 'ID003' }), taken)).toMatch(/-002\.txt$/);
  });

  it('gives up on the counter rather than looping, past a thousand', () => {
    const stem = transcriptFileStem(recording());
    const taken = new Set([`${stem}.txt`]);
    for (let n = 1; n < 1000; n += 1) taken.add(`${stem}-${String(n).padStart(3, '0')}.txt`);
    expect(transcriptFileName(recording(), taken)).toBe(`${stem}-ID001.txt`);
  });
});

describe('transcriptFileHeader', () => {
  const source = (over: Record<string, unknown> = {}) => ({
    recording: recording({ title: 'Backend standup' }),
    segments: [segment('speaker_00'), segment('speaker_01')],
    speakers: [{ label: 'speaker_00', name: 'Ann' }] as SpeakerName[],
    tags: ['standup', 'backend'],
    ...over,
  });

  it('states the title, date, tags and participants the prompt promises are there', () => {
    const header = transcriptFileHeader(source() as never);
    expect(header).toContain('Title: Backend standup');
    expect(header).toMatch(/Recorded: 2026\.08\.24 \d{2}:\d{2}/);
    expect(header).toContain('Tags: standup, backend');
    expect(header).toContain('Participants: Ann');
  });

  it('falls back to the source path when there is no title', () => {
    expect(transcriptFileHeader(source({ recording: recording() }) as never)).toContain(
      'Title: /in/standup.m4a',
    );
  });

  it('says "(none)" rather than dropping the line', () => {
    // An absent line reads as a truncated header; an explicit none is a fact.
    const header = transcriptFileHeader(source({ tags: [] }) as never);
    expect(header).toContain('Tags: (none)');
  });

  it('says so when nobody was identified', () => {
    const header = transcriptFileHeader(
      source({ speakers: [], segments: [segment(null)] }) as never,
    );
    expect(header).toContain('Participants: (not identified)');
  });

  it('marks an unnamed label instead of passing it off as a name', () => {
    // It has to be listed -- the transcript lines say "speaker_01:", so a
    // model that never saw the label cannot attribute to it. It has to be
    // marked -- the prompt says this line names who took part, and a bare
    // "speaker_01" there gets attributed as though it were somebody's name.
    const header = transcriptFileHeader(source() as never);
    expect(header).toContain('Participants: Ann, speaker_01 (unnamed)');
  });

  it('keeps every line, so a truncated header is detectable', () => {
    expect(transcriptFileHeader(source() as never).split('\n')).toHaveLength(4);
  });
});
