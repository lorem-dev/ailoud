import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Ready-made jobs, for a client that offers prompts as slash commands.
 *
 * These are not shortcuts for the tools; they are the multi-step routines that
 * are easy to get wrong -- searching before reading, tagging what is untagged,
 * picking a template before summarising. A prompt is where the right order of
 * operations can be stated once instead of hoped for.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'catch-up',
    {
      title: 'Catch up on a topic',
      description:
        'Answer a question about the library the cheap way: search, then read only what the ' +
        'search points at.',
      argsSchema: {
        question: z.string().describe('What you want to know, in your own words.'),
        tags: z.string().optional().describe('Comma-separated tags to confine the search to.'),
      },
    },
    ({ question, tags }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Answer this about my recordings: ${question}`,
              '',
              'Work in this order:',
              `1. search_transcripts for the words that would appear if this were discussed${
                tags === undefined ? '' : `, with tags ${tags}`
              }. Try more than one phrasing before concluding it is not there.`,
              '2. Read the hits. They carry the recording, the timestamp and the speaker.',
              '3. Only if the hits are not enough, get_transcript for the one recording that ' +
                'looks most relevant, and read the part around the timestamps you found.',
              '4. Answer with who said what and when. Cite recording ids and timestamps.',
              '',
              'Do not read whole transcripts to begin with. That is the expensive way to do this.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'tidy-library',
    {
      title: 'Tag what is untagged',
      description:
        'Find recordings that cannot be filtered by context and propose tags for them, from ' +
        'what they actually contain.',
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Help me tag my library so I can filter it by context.',
              '',
              '1. list_tags, to learn the spellings already in use. Reuse them rather than ' +
                'inventing variants -- "1on1" and "one-on-one" as two tags is worse than either.',
              '2. list_untagged.',
              '3. For each untagged recording, search_transcripts or read the preview to work ' +
                'out what it is about. Do not guess from the file name alone.',
              '4. Propose tags for each, and say why. Wait for me to agree before calling ' +
                'annotate.',
              '5. While you are there, note any recording whose speakers are still ' +
                '"speaker_00": annotate can give them real names, and every later summary is ' +
                'better for it.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'summarise-properly',
    {
      title: 'Summarise with the right shape',
      description:
        'Summarise a recording or a tagged group, choosing the template that fits and supplying ' +
        'the context the transcript does not contain.',
      argsSchema: {
        what: z.string().describe('Recording ids, or a tag, or a description of which recordings.'),
        background: z
          .string()
          .optional()
          .describe(
            'Anything the transcript does not say: who these people are, what the project is.',
          ),
      },
    },
    ({ what, background }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Summarise: ${what}`,
              ...(background === undefined ? [] : ['', `Background: ${background}`]),
              '',
              '1. list_templates first. Pick the one that matches the kind of conversation this ' +
                'is -- a one-to-one, a performance review, a design discussion, a decision ' +
                'between solutions. The default meeting shape answers those badly.',
              '2. list_reports for this material, in case a summary already exists. Reading one ' +
                'is free; making one is not.',
              '3. summarize with that template, and pass the background above as `context`. ' +
                'Keep the background in your own memory for later calls -- laud does not ' +
                'remember it.',
              '4. Tell me which template you chose and why.',
            ].join('\n'),
          },
        },
      ],
    }),
  );
}
