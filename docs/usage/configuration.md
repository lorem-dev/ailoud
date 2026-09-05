# Configuration

| Path                                  | Holds                                         |
| ------------------------------------- | --------------------------------------------- |
| `$XDG_CONFIG_HOME/ailoud/config.yaml` | settings (default `~/.config/ailoud`)         |
| `$XDG_CONFIG_HOME/ailoud/templates/`  | [summary templates](templates.md)             |
| `$XDG_DATA_HOME/ailoud/ailoud.db`     | the library (default `~/.local/share/ailoud`) |
| `$XDG_DATA_HOME/ailoud/media/`        | AILoud's copies of your audio                 |

`ailoud setup` writes the config file for you. Edit it by hand any time.

## A full config file

```yaml
stt:
  provider: whisper-cpp
  whisperCpp:
    binary: whisper-cli
    model: ~/.local/share/ailoud/models/ggml-small.bin
    vadBinary: whisper-vad-speech-segments
    vadModel: ~/.local/share/ailoud/models/ggml-silero-v5.1.2.bin
  diarization:
    binary: sherpa-onnx-offline-speaker-diarization
    segmentationModel: ~/.local/share/ailoud/models/sherpa-pyannote-segmentation-3-0.onnx
    embeddingModel: ~/.local/share/ailoud/models/3dspeaker_campplus.onnx
    threshold: 0.6
    threads: 4

llm:
  provider: claude-cli
  claudeCli:
    binary: claude
    model: sonnet
    contextTokens: 200000
```

## Language model

Pick one provider. The others are ignored.

=== "Local"

    ```yaml
    llm:
      provider: llama-cpp
      llamaCpp:
        binary: llama-cli
        model: ~/.local/share/ailoud/models/qwen2.5-3b-instruct-q4_k_m.gguf
        contextTokens: 8192
        maxOutputTokens: 1024
        threads: 4
    ```

=== "Claude, subscription"

    ```yaml
    llm:
      provider: claude-cli
      claudeCli:
        binary: claude
        model: sonnet
        contextTokens: 200000
    ```

    Uses your [Claude Code](https://claude.com/claude-code) sign-in. No API
    key.

=== "Claude, API"

    ```yaml
    llm:
      provider: anthropic
      anthropic:
        baseUrl: https://api.anthropic.com/v1
        model: claude-sonnet-5
        contextTokens: 200000
        maxOutputTokens: 2048
    ```

    Needs `ANTHROPIC_API_KEY`.

=== "OpenAI or compatible"

    ```yaml
    llm:
      provider: openai-compatible
      openaiCompatible:
        baseUrl: https://api.openai.com/v1
        model: gpt-4o-mini
        contextTokens: 128000
        maxOutputTokens: 1024
    ```

    Needs `OPENAI_API_KEY`. Point `baseUrl` at
    [Ollama](https://ollama.com/) or LM Studio for a local server, which needs
    no key.

## Environment variables

| Variable             | Used for                                        |
| -------------------- | ----------------------------------------------- |
| `AILOUD_LLM_API_KEY` | any provider; wins over the vendor variable     |
| `ANTHROPIC_API_KEY`  | `anthropic`                                     |
| `OPENAI_API_KEY`     | `openai-compatible`                             |
| `XDG_CONFIG_HOME`    | where the config lives                          |
| `XDG_DATA_HOME`      | where the library lives                         |
| `PAGER`              | which pager long output uses; empty disables it |

Keys are read from the environment only. They are never written to
`config.yaml` and never logged. A variable that is set but empty counts as
unset.

## Choosing a model

`setup` asks the provider which models your key can use:

```
ailoud setup --llm claude-api
```

Answer up front instead:

```
ailoud setup --llm claude-api --llm-model claude-opus-5 --yes
```

!!! warning "Context size is not adjusted for you"

    No provider reports a model's context window, so switching to a
    small-context model needs `contextTokens` set by hand. The symptom is a
    context error from the API on a long transcript.

## When doctor is unhappy

```
ailoud doctor
ailoud doctor --fix
```

`doctor` reports every binary, model, path and permission with a fix for each.

```
ok    ffmpeg                         ffmpeg version 9.0.1
FAIL  whisper model                  not configured
      fix: Set "stt.whisperCpp.model" in ~/.config/ailoud/config.yaml ...
n/a   language model                 not configured
```

Three states, not two:

| State  | Means                                                 |
| ------ | ----------------------------------------------------- |
| `ok`   | ready                                                 |
| `FAIL` | AILoud cannot run until this is fixed                 |
| `n/a`  | an opt-in feature is off; everything else still works |

`n/a` covers `--multilingual`, `--diarize` and summaries. They never make
`doctor` fail.

Exit codes: `0` ok, `1` failure, `2` usage, `3` environment.

## Concurrency

`setup` and `doctor --fix` take a lock on the data directory, so two runs
cannot download into the same path at once. A stale lock left by a crash is
taken over automatically.
