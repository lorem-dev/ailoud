/**
 * A kind of conversation, and the shape a summary of it should take.
 *
 * The headings differ because the questions differ: a one-to-one is about
 * agreements and concerns, an architecture session is about which options were
 * weighed and what was ruled out, and an offsite is about themes that recurred
 * across a day. One heading set for all three would answer none of them well.
 *
 * `context` is a sentence handed to the model rather than a mode it switches
 * into: it says what kind of conversation this was, which is exactly the
 * knowledge a reader of the transcript has and the model does not.
 */
export interface SummaryTemplate {
  readonly name: string;
  /** What to tell the model this recording is. */
  readonly context: string;
  /** The headings for this kind of conversation, in order. */
  readonly headings: readonly string[];
  /** Shown in `--help` and in the MCP tool description. */
  readonly summary: string;
}

export const SUMMARY_TEMPLATES: readonly SummaryTemplate[] = [
  {
    name: 'meeting',
    context: 'This is a meeting.',
    headings: ['Decisions', 'Open questions', 'Notes'],
    summary: 'the default shape: decisions, open questions, notes',
  },
  {
    name: 'one-on-one',
    context:
      'This is a one-to-one between a manager and a report. It is a private conversation: ' +
      'concerns and how someone feels about their work matter as much as decisions.',
    headings: ['Agreements', 'Concerns raised', 'Follow-ups', 'Notes'],
    summary: 'a private 1:1 -- agreements, concerns, follow-ups',
  },
  {
    name: 'performance-review',
    context:
      'This is a performance review. Specific evidence matters more than judgement: what was ' +
      'actually done, what was actually said about it, and what was agreed for next time. ' +
      'Praise and criticism are both findings and belong in the summary as they were expressed.',
    headings: [
      'Strengths cited',
      'Areas for improvement',
      'Evidence and examples',
      'Agreed goals',
      'Disagreements',
    ],
    summary: 'performance review -- evidence, agreed goals, disagreements',
  },
  {
    name: 'architecture-planning',
    context:
      'This is a technical design discussion. Which options were weighed, and why one was ' +
      'chosen or ruled out, matters as much as the conclusion.',
    headings: ['Decisions', 'Options considered', 'Trade-offs', 'Risks', 'Open questions'],
    summary: 'design discussion -- decisions, options weighed, trade-offs, risks',
  },
  {
    name: 'solution-decision',
    context:
      'This conversation is choosing between specific solutions. The decision, the reasoning ' +
      'behind it, and what was rejected are the whole point; record what would change the ' +
      'decision if it turned out to be wrong.',
    headings: [
      'Decision',
      'Reasoning',
      'Rejected alternatives',
      'What would change this decision',
      'Next steps',
    ],
    summary: 'choosing between solutions -- decision, reasoning, what was rejected',
  },
  {
    name: 'offsite',
    context:
      'This is an offsite or a workshop, likely long and ranging over several topics. What ' +
      'recurred across the day matters as much as any single exchange.',
    headings: ['Themes', 'Decisions', 'Actions', 'Notes'],
    summary: 'offsite or workshop -- themes, decisions, actions',
  },
];

export const DEFAULT_TEMPLATE = 'meeting';

export function findTemplate(name: string): SummaryTemplate | undefined {
  const wanted = name.trim().toLowerCase();
  return SUMMARY_TEMPLATES.find((template) => template.name === wanted);
}

/** The names, for an error message or a `--help` line. */
export function templateNames(): string {
  return SUMMARY_TEMPLATES.map((template) => template.name).join(', ');
}
