/**
 * What the agent is told about ailoud before it calls anything.
 *
 * This is the single most valuable piece of text in the MCP surface. A tool
 * description explains one call; this explains the shape of the thing, which
 * is what stops an agent reading four transcripts into its context to answer a
 * question that one search would have answered.
 *
 * Written as rules with reasons rather than a feature list, because an agent
 * that knows why a rule exists applies it to the case nobody wrote down.
 */
export const SERVER_INSTRUCTIONS = `
ailoud is a local library of audio and video recordings, their transcripts, and
summaries ("reports") made from them. Everything is on this machine; nothing
here calls out to a service unless a tool says it does.

The shape of the library:

- A RECORDING is an imported audio or video file. It has an id (a 26-character
  ULID), a date taken from the file's own metadata where it has one, optional
  title and notes, and TAGS.
- A TRANSCRIPT belongs to a recording: timestamped segments, each with a
  language and, when diarization ran, a speaker label. Speaker labels look
  like "speaker_00" until someone gives them real names.
- A REPORT is a summary of one or several recordings, written by a language
  model. It records which template shaped it, what context it was given, and
  which model wrote it.

Six rules, in the order they matter:

1. TAG EVERYTHING. A tag is the only way to ask for "the recordings about this
   project" or "my one-to-ones". Untagged recordings are findable by id and by
   full-text search and by nothing else, which stops working as soon as a
   library has more than a handful. When you import or transcribe, pass tags.
   When you notice an untagged recording, offer to tag it -- \`list_untagged\`
   exists for exactly that. Tags are lowercase words; several tags on one
   recording narrow rather than widen, so \`["release", "backend"]\` means a
   recording carrying both.

2. SEARCH BEFORE READING. \`search_transcripts\` returns the matching lines
   with timestamps and speakers, usually a few hundred bytes. Reading a
   transcript costs thousands of tokens and buys nothing if the question was
   "when did they discuss the rollback". Reach for a transcript only when you
   genuinely need the whole conversation.

3. TRANSCRIPTS ARRIVE AS FILES. \`get_transcript\` writes the transcript to a
   temporary file and returns its PATH, its line count and its duration -- not
   its text. Read the part you need with your own file tools. The file exists
   for the length of this server's run.

4. PICK A TEMPLATE FOR A SUMMARY. \`list_templates\` shows what shapes are
   available -- a one-to-one, a performance review, an architecture
   discussion, a decision between solutions. The headings differ because the
   questions differ, and the default meeting shape answers a one-to-one badly.
   Prefer an existing template. Creating a new one is possible
   (\`create_template\`) but is rarely the right move: check the list first,
   and consider whether \`context\` would do instead.

5. CARRY THE CONTEXT YOURSELF. \`summarize\` takes a short \`context\` -- who
   these people are to each other, what the project is called, what happened
   last week. ailoud does not remember it between calls. Keep whatever the user
   told you and pass it again on the next summary of the same material; it is
   the one thing you know that the transcript does not say.

6. TRANSCRIBING AND SUMMARISING COST SOMETHING. Transcription is minutes of
   CPU per recording. Summarising spends tokens on a hosted model or minutes
   on a local one. Neither has a default selection: name the recordings.

Deleting is deliberately awkward. \`delete_recording\` and \`delete_report\`
never delete on the first call: they describe what would go and return a
confirmation token, and only a second call carrying that token deletes.
Show the user what the first call reported and get their agreement before
sending the second. A recording deleted this way is not recoverable.

Ids may be abbreviated, as in docker: any unambiguous prefix of at least two
characters works, and an ambiguous one is reported with the candidates.
`.trim();
