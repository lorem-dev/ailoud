import { describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS } from './instructions.js';

describe('performance guidance', () => {
  it('says the gpu is what makes transcription fast', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/ten times faster/);
  });

  it('says threads matter without a gpu and barely matter with one', () => {
    // Both halves, because the advice inverts between the two machines and
    // half of it is actively wrong on the other.
    expect(SERVER_INSTRUCTIONS).toMatch(/barely changes anything/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/four times/);
  });

  it('names diarization as the cpu-bound stage', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/diarization always runs on the CPU/i);
  });

  it('tells the agent to run doctor rather than ask the user', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/Do not ask the user about CPU or GPU/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/run .?doctor.?/);
  });

  it('never names the per-run flag', () => {
    expect(SERVER_INSTRUCTIONS).not.toContain('--max-cpu');
  });

  it('adds no seventh rule', () => {
    // The guidance belongs inside rule 6, which already opens with what
    // transcription costs. A seventh rule would dilute the six that matter.
    expect(SERVER_INSTRUCTIONS).toContain('Six rules');
    expect(SERVER_INSTRUCTIONS).not.toMatch(/^7\./m);
  });

  it('tells the agent to ask who the numbered speakers are', () => {
    expect(SERVER_INSTRUCTIONS).toContain('unnamedSpeakers');
    expect(SERVER_INSTRUCTIONS).toContain('annotate');
  });
});
