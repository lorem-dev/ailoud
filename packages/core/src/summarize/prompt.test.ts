import { describe, expect, it } from 'vitest';
import type { Recording, Segment, SpeakerName } from '../domain/model.js';
import { buildSummaryRequest, instruction, languageName, wordCap } from './prompt.js';
import { findTemplate } from './templates.js';
import type { SummarySource } from './prompt.js';

const recording = (id: string, title: string, recordedAt: string): Recording => ({
  id,
  sha256: id,
  sourcePath: `/in/${id}.m4a`,
  mediaPath: `/lib/${id}.m4a`,
  durationMs: 1000,
  mime: 'audio/mp4',
  title,
  notes: null,
  recordedAt,
  importedAt: '2026-08-30T12:00:00.000Z',
});

function segments(count: number, words = 4): Segment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    transcriptId: 't',
    idx: i,
    startMs: i * 1000,
    endMs: i * 1000 + 900,
    text: `line ${i} ${'word '.repeat(words).trim()}`,
    speaker: i % 2 === 0 ? 'speaker_00' : 'speaker_01',
    language: 'en',
  })) as Segment[];
}

const source = (over: Partial<SummarySource> = {}): SummarySource => ({
  recording: recording('ID001', 'Backend standup', '2026-08-24T09:30:15.000Z'),
  segments: segments(4),
  speakers: [
    { label: 'speaker_00', name: 'Ann' },
    { label: 'speaker_01', name: 'Ben' },
  ] as SpeakerName[],
  tags: ['standup'],
  ...over,
});

describe('wordCap', () => {
  it('caps a single recording tightly', () => {
    // Measured, not chosen: with no cap, sonnet and opus ran 270-330 words on
    // a long transcript on every run, and a summary nobody finishes reading
    // is not a summary.
    expect(wordCap(1)).toBe(200);
  });

  it('grows with how much was handed over, but not without limit', () => {
    expect(wordCap(3)).toBeGreaterThan(wordCap(1));
    expect(wordCap(50)).toBe(600);
  });
});

describe('languageName', () => {
  it('turns a code into the word the model has actually been trained on', () => {
    // "Write in Russian" beats "Write in ru": adherence to the language
    // instruction is the thing this feature exists for.
    expect(languageName('ru')).toBe('Russian');
    expect(languageName('EN')).toBe('English');
  });

  it('passes anything it does not know straight through', () => {
    // A courtesy for the codes people type, not a whitelist.
    expect(languageName('Latvian')).toBe('Latvian');
    expect(languageName('plain English')).toBe('plain English');
  });
});

describe('instruction', () => {
  it('defaults to the transcript language, not English', () => {
    // laud exists for recordings that are not in English; summarising a
    // Russian meeting into English is a translation nobody asked for.
    expect(instruction({ cap: 200 })).toContain('the language the transcript is in');
  });

  it('names an explicitly requested language', () => {
    expect(instruction({ language: 'English', cap: 200 })).toContain('Write in English.');
    expect(instruction({ language: 'English', cap: 200 })).not.toContain(
      'the language the transcript is in',
    );
  });

  it('tells the model the header exists and what is in it', () => {
    // The header is only useful if the model is told to read it; these two
    // must not drift apart.
    const text = instruction({ cap: 200 });
    expect(text).toMatch(/header/i);
    for (const field of ['title', 'recorded', 'tags']) expect(text.toLowerCase()).toContain(field);
  });

  it('carries the cap it was given', () => {
    expect(instruction({ cap: 450 })).toContain('Under 450 words');
  });
});

describe('buildSummaryRequest', () => {
  const generous = { budgetTokens: 100_000 };

  it('writes one whole file per recording, named from its date', () => {
    const request = buildSummaryRequest([source()], generous);
    expect(request.files).toHaveLength(1);
    expect(request.files[0]!.name).toMatch(/^record-\d{14}\.txt$/);
    expect(request.files[0]!.recordingId).toBe('ID001');
  });

  it('puts the header at the top of the file, then the transcript', () => {
    const content = buildSummaryRequest([source()], generous).files[0]!.content;
    expect(content.startsWith('Title: Backend standup')).toBe(true);
    expect(content).toContain('Tags: standup');
    expect(content).toContain('Ann: line 0');
  });

  it('gives distinct file names to recordings sharing a second', () => {
    const same = '2026-08-24T09:30:15.000Z';
    const request = buildSummaryRequest(
      [source(), source({ recording: recording('ID002', 'Other', same), segments: segments(2) })],
      generous,
    );
    expect(new Set(request.files.map((f) => f.name)).size).toBe(2);
  });

  it('asks in one pass when it all fits', () => {
    const request = buildSummaryRequest([source()], generous);
    expect(request.parts).toHaveLength(1);
    expect(request.combine).toBe('');
  });

  it('names each file in the prompt, so the model can say where a point came from', () => {
    const request = buildSummaryRequest([source()], generous);
    expect(request.parts[0]).toContain(request.files[0]!.name);
  });

  it('splits into portions when the budget is small, and supplies a combine step', () => {
    const request = buildSummaryRequest([source({ segments: segments(200) })], {
      budgetTokens: 300,
    });
    expect(request.parts.length).toBeGreaterThan(1);
    expect(request.combine).not.toBe('');
  });

  it('keeps the files whole even when the prompt is portioned', () => {
    // What is portioned is what goes into a request, not what is on disk.
    const all = segments(200);
    const request = buildSummaryRequest([source({ segments: all })], { budgetTokens: 300 });
    expect(request.files).toHaveLength(1);
    expect(request.files[0]!.content).toContain('line 199');
  });

  it('repeats the header on every portion', () => {
    // Each portion is answered in its own request with no memory of the last;
    // a portion without the header is a transcript from nowhere, by nobody.
    const request = buildSummaryRequest([source({ segments: segments(200) })], {
      budgetTokens: 300,
    });
    for (const part of request.parts) expect(part).toContain('Title: Backend standup');
  });

  it('numbers the portions so the model knows it is seeing a slice', () => {
    const request = buildSummaryRequest([source({ segments: segments(200) })], {
      budgetTokens: 300,
    });
    expect(request.parts[0]).toMatch(/portion 1 of \d+/);
  });

  it('carries the requested language into every portion and the combine step', () => {
    const request = buildSummaryRequest([source({ segments: segments(200) })], {
      budgetTokens: 300,
      language: 'en',
    });
    for (const part of request.parts) expect(part).toContain('Write in English.');
    expect(request.combine).toContain('English');
  });

  it('uses a stored summary in place of the transcript when given one', () => {
    const request = buildSummaryRequest(
      [source({ priorSummary: 'They agreed to ship.' })],
      generous,
    );
    expect(request.parts[0]).toContain('They agreed to ship.');
    expect(request.parts[0]).not.toContain('line 0');
  });

  it('says that a reused summary is a summary, not a transcript', () => {
    // Unlabelled, the model would report a paraphrase as though it were what
    // somebody actually said.
    const request = buildSummaryRequest([source({ priorSummary: 'They agreed.' })], generous);
    expect(request.parts[0]).toMatch(/earlier summary/i);
  });

  it('needs no portioning for a reused summary, however long the transcript was', () => {
    const request = buildSummaryRequest(
      [source({ segments: segments(500), priorSummary: 'Short.' })],
      { budgetTokens: 300 },
    );
    expect(request.parts).toHaveLength(1);
  });
});

describe('instruction: not inventing what is not there', () => {
  it('does not demand a speaker for a point the transcript does not attribute', () => {
    // Measured: with an unconditional "name the speaker for every point", an
    // undiarized recording made sonnet and opus label everything "Speaker A"
    // and "Speaker B" on every run -- people who do not exist.
    const text = instruction({ cap: 200 });
    expect(text).toMatch(/attributes none|does not attribute/i);
    expect(text).toMatch(/do not invent a speaker/i);
  });

  it('also forbids announcing the absence on every line', () => {
    // The first fix traded invented speakers for "(speaker not identified)"
    // repeated after every bullet, which is noise rather than information.
    expect(instruction({ cap: 200 })).toMatch(/do not note that there was none/i);
  });

  it('forbids commentary about the transcript itself', () => {
    // Both larger models liked to close with an italic note about what could
    // not be determined. Nobody asked for a summary of the summary's limits.
    expect(instruction({ cap: 200 })).toMatch(/no commentary on the transcript/i);
  });
});

describe('instruction: template and caller context', () => {
  const oneOnOne = findTemplate('one-on-one')!;

  it('uses the template headings rather than the meeting ones', () => {
    const text = instruction({ cap: 200, template: oneOnOne });
    expect(text).toContain('Concerns raised');
    expect(text).not.toContain('Open questions\nNotes');
  });

  it('tells the model what kind of conversation it is reading', () => {
    // The knowledge a person in the room has and the transcript does not say.
    expect(instruction({ cap: 200, template: oneOnOne })).toMatch(/one-to-one/i);
  });

  it('carries the caller context above the rules, not below them', () => {
    // Below the rules it reads as one more constraint; above, it is what the
    // recording IS.
    const text = instruction({ cap: 200, context: "Ann is Ben's manager." });
    const atContext = text.indexOf("Ann is Ben's manager.");
    const atRules = text.indexOf('Write in');
    expect(atContext).toBeGreaterThan(-1);
    expect(atContext).toBeLessThan(atRules);
  });

  it("labels the context as the caller's, not as transcript content", () => {
    // Unlabelled, a sentence handed in from outside is indistinguishable from
    // something somebody said, and gets attributed.
    expect(instruction({ cap: 200, context: 'They met last week too.' })).toMatch(
      /Context from the person asking/,
    );
  });

  it('lets the model use the context, having forbidden outside knowledge', () => {
    // The old wording said "no outside context" flatly, which contradicts a
    // context the caller just supplied.
    const text = instruction({ cap: 200, context: 'x' });
    expect(text).toMatch(/transcripts and the context above/);
  });

  it('adds no context line when none was given or it is blank', () => {
    for (const context of [undefined, '', '   ']) {
      const text = instruction({ cap: 200, ...(context === undefined ? {} : { context }) });
      expect(text, JSON.stringify(context)).not.toMatch(/Context from the person asking/);
    }
  });

  it('carries the template into the built request', () => {
    const request = buildSummaryRequest([source()], {
      budgetTokens: 100_000,
      template: oneOnOne,
      context: 'Ann is the manager.',
    });
    expect(request.parts[0]).toContain('Concerns raised');
    expect(request.parts[0]).toContain('Ann is the manager.');
  });
});
