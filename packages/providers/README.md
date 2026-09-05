# @ailoud/providers

The adapters of [AILoud](https://github.com/lorem-dev/ailoud): each port
declared in [`@ailoud/core`](https://www.npmjs.com/package/@ailoud/core),
implemented against something real.

| Port                    | Implemented with                                            |
| ----------------------- | ----------------------------------------------------------- |
| `AudioTool`             | ffmpeg and ffprobe                                          |
| `TranscriptionProvider` | whisper.cpp                                                 |
| `RecordingStore`        | SQLite (`node:sqlite`) with FTS5 search                     |
| `Summarizer`            | llama.cpp, the Claude CLI, or the Anthropic and OpenAI APIs |

These talk to binaries and files on the machine, so they are covered by the
end-to-end suite rather than by mocks.

Published because the CLI depends on it. The interfaces are not stable yet, and
there is no reason to depend on this package directly.

Documentation: <https://lorem-dev.github.io/ailoud/>
