# AILoud Changelog

<!--
  RULES FOR THIS FILE. Read them before adding an entry.

  Audience: someone deciding whether to upgrade. Not a commit log, and not a
  record of how the code got this way -- that belongs in commit messages and
  code comments, both of which survive and are searchable.

  LIMITS per version section, counting every bullet across its subsections:
    soft  10  -- aim for this. Over it, look for entries to merge or cut.
    hard  50  -- a release must not ship with more. Merge related entries into
                 one that names the feature, or cut what does not affect a
                 user.

  What goes in:
    - A feature, option or command a user can now use.
    - A change in behaviour they would otherwise be surprised by.
    - A fix for something that was BROKEN IN A RELEASED VERSION.
    - A removal, or anything needing action on upgrade.

  What stays out:
    - Anything fixed before it ever shipped. If a released version never had
      the bug, the changelog has nothing to say about it. Before the first
      release, that is every fix.
    - Refactoring, test changes, CI, internal renames, dependency bumps with
      no user-visible effect.
    - The reasoning behind a change. One clause of why is fine when it changes
      what a reader does; an essay is not.

  Form:
    - One entry per user-visible thing. Present tense, active voice.
    - Name the command or option in backticks, so it is greppable.
    - Wrap at 80 columns. ASCII only (see AGENTS.md).

  Sections: `## Development` collects unreleased entries. `bump-version`
  promotes it to `## Version <v>` and `release-notes.mjs` extracts that section
  for the GitHub release, so the heading format matters.
-->

## Development

### Fixed

- Each published package carries a README, so its page on npm describes what it
  is instead of saying it has none.

## Version 1.0.0-dev.1

### Added

- `ailoud audio import` adds audio and video files, or whole directories, to a
  local library. `--tag` groups them so they can be found by context later.
- `ailoud audio transcribe` turns recordings into timestamped transcripts with
  whisper.cpp. `--lang ru,en` detects and preserves each language in a
  code-switched recording; `--diarize` attributes lines to speakers, and
  `ailoud audio annotate --speaker speaker_00=Ann` gives them real names.
- `ailoud audio search` finds where something was said across the library,
  returning the matching lines with timestamps rather than whole transcripts.
  Case-insensitive in every language, with `*` for a prefix search.
- `ailoud audio summarize` writes a summary with a language model and saves it
  as a report. `--template` shapes it for the kind of conversation -- a 1:1, a
  performance review, an architecture discussion, a decision between solutions
  -- and `--context` supplies what the transcript does not say. Templates are
  editable YAML files under the config directory.
- Four summarisation engines behind one setting: a local GGUF model through
  llama.cpp, Claude by subscription through the Claude Code CLI, Claude by API,
  and any OpenAI-compatible endpoint including Ollama and LM Studio.
- `ailoud report ls|show|rm` lists, prints and deletes saved reports.
- `ailoud mcp` serves the library to an AI agent over MCP: sixteen tools, three
  prompts, and transcripts as addressable resources. Deleting takes two calls,
  the first describing exactly what would go.
- `ailoud mcp install|uninstall|update` configures Claude Code, Codex CLI,
  opencode, Gemini CLI, Hermes and GitHub Copilot CLI, and writes the guidance
  block those agents read.
- A project can keep its own library in `.ailoud/`, found by walking up from
  the working directory the way git finds `.git`.
- `ailoud setup` provisions a fresh machine -- ffmpeg, whisper.cpp, the models,
  and optionally a local summarisation model -- printing every command it will
  run, including any `sudo`, and asking once. `ailoud doctor` reports every
  missing tool, model and permission with a fix for each, and `--fix` acts on
  them.
- Commands are grouped by the noun they act on (`ailoud audio ls`,
  `ailoud report show`), each verb has a one-letter alias, and the short
  top-level spellings keep working.
- Output is decorated on a terminal and plain everywhere else, so `--json` and
  `--format srt` are byte-stable in a pipe. Anything over 30 lines opens in
  your pager.
- API keys are read from the environment only, never from the config file and
  never logged.
- Documentation at https://lorem-dev.github.io/ailoud/, published per release.
- Published to npm as `ailoud`, with `@ailoud/core` and `@ailoud/providers` for
  anyone building on the layers underneath.
