import { describe, expect, it } from 'vitest';
import type { Segment } from '../domain/model.js';
import { chunkTranscript, estimateTokens, transcriptLine } from './chunk.js';

const seg = (startMs: number, text: string, speaker: string | null = null): Segment => ({
  id: `s${startMs}`,
  transcriptId: 't',
  idx: startMs,
  startMs,
  endMs: startMs + 1000,
  text,
  speaker,
  language: null,
});

describe('estimateTokens', () => {
  it('grows with the text', () => {
    expect(estimateTokens('x'.repeat(100))).toBeGreaterThan(estimateTokens('x'.repeat(10)));
  });

  it('errs high rather than low', () => {
    // Under-estimating means overflowing the model's context and finding out
    // only after the work is done; over-estimating costs one extra chunk.
    // English is roughly four characters per token, so a hundred characters
    // must estimate at more than twenty-five.
    expect(estimateTokens('x'.repeat(100))).toBeGreaterThan(25);
  });
});

describe('transcriptLine', () => {
  it('carries the timestamp and the speaker', () => {
    expect(transcriptLine(seg(61_000, 'hello', 'speaker_00'), new Map())).toBe(
      '[00:01:01] speaker_00: hello',
    );
  });

  it('uses the name a human gave, which is why annotate exists', () => {
    expect(transcriptLine(seg(0, 'hello', 'speaker_00'), new Map([['speaker_00', 'Ann']]))).toBe(
      '[00:00:00] Ann: hello',
    );
  });

  it('omits the speaker entirely when there is none', () => {
    expect(transcriptLine(seg(0, 'hello'), new Map())).toBe('[00:00:00] hello');
  });
});

describe('chunkTranscript', () => {
  it('keeps a short transcript in one piece', () => {
    const chunks = chunkTranscript([seg(0, 'one'), seg(1000, 'two')], new Map(), 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('one');
    expect(chunks[0]).toContain('two');
  });

  it('splits a long one', () => {
    const segments = Array.from({ length: 50 }, (_, i) => seg(i * 1000, 'x'.repeat(100)));
    expect(chunkTranscript(segments, new Map(), 200).length).toBeGreaterThan(1);
  });

  it('never splits inside a segment', () => {
    // A sentence cut across two requests is summarised twice, badly. Segments
    // are the recording's own seams.
    //
    // Indices are zero-padded so the search is exact: an unpadded "line-1"
    // is a substring of "line-10" through "line-19", and the first version of
    // this test failed on its own sloppiness rather than on the code.
    const segments = Array.from({ length: 20 }, (_, i) =>
      seg(i * 1000, `line-${String(i).padStart(2, '0')}`),
    );
    const chunks = chunkTranscript(segments, new Map(), 20);
    for (let i = 0; i < 20; i += 1) {
      const needle = `line-${String(i).padStart(2, '0')}`;
      expect(chunks.filter((chunk) => chunk.includes(needle))).toHaveLength(1);
    }
  });

  it('emits an oversized segment alone rather than dropping or truncating it', () => {
    // It will overflow and the model will say so, which is a better failure
    // than silently losing the longest thing anyone said.
    const segments = [seg(0, 'x'.repeat(10_000)), seg(1000, 'short')];
    const chunks = chunkTranscript(segments, new Map(), 50);
    expect(chunks[0]).toContain('x'.repeat(10_000));
    expect(chunks[0]).not.toContain('short');
  });

  it('loses no segment, however it splits', () => {
    const segments = Array.from({ length: 40 }, (_, i) =>
      seg(i * 1000, `line-${String(i).padStart(2, '0')}`),
    );
    const joined = chunkTranscript(segments, new Map(), 30).join('\n');
    for (let i = 0; i < 40; i += 1) {
      expect(joined).toContain(`line-${String(i).padStart(2, '0')}`);
    }
  });

  it('returns nothing for no segments', () => {
    expect(chunkTranscript([], new Map(), 100)).toEqual([]);
  });
});
