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
resources:
  maxCpuPercent: 90
  gpu: true

audio:
  denoise: auto

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

| Key                       | Default | Means                                                                                             |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `resources.maxCpuPercent` | `90`    | Share of the machine's fast cores an engine may use, 1 to 100.                                    |
| `resources.gpu`           | `true`  | Use the GPU where a binary supports it.                                                           |
| `audio.denoise`           | `auto`  | `auto` measures the audio and cleans only noisy recordings. `on` always cleans, `off` never does. |
| `stt.diarization.threads` | `null`  | Follow `maxCpuPercent`. A number overrides it.                                                    |
| `llm.llamaCpp.threads`    | `null`  | Follow `maxCpuPercent`. A number overrides it.                                                    |

### Acceleration

`ailoud doctor` reports which backends each engine loaded:

```
GPU build (BLAS, MTL, CPU): transcription is already fast, and threads mainly affect speaker diarization. Raise resources.maxCpuPercent only if diarization is slow.
ok    cpu                            10 logical, 8 performance -> 7 threads, 6 for segmentation and diarization, at 90%
ok    whisper backends               BLAS, MTL, CPU
n/a   neural engine                  not available: whisper.cpp reaches the Neural Engine only when built with CoreML support and given a converted model, which the packaged build is not
```

whisper.cpp and llama.cpp use Metal or CUDA automatically when their build
supports it, so there is no flag to turn that on.

What actually changes the speed, measured on 40 seconds of audio with the
`small` model:

| Threads | GPU build | CPU-only build |
| ------- | --------- | -------------- |
| 1       | 2.6 s     | 77.0 s         |
| 4       | 2.1 s     | 21.0 s         |
| 8       | 1.9 s     | 19.6 s         |

- A GPU build is about ten times faster, and needs no flag.
- On a GPU build the thread count barely matters, so one thread is fine and
  leaves the CPU free.
- Without a GPU, threads are worth about four times, and nearly all of that
  by four threads.
- Speech segmentation and speaker diarization always run on the CPU, and both
  get a lower share than the other engines because both were measured to slow
  down past it -- the segmenter by 39 percent at 7 threads against 6, the
  diarizer by 25 percent.

Apple's Neural Engine would move the encoder off the GPU onto the Neural
Engine, freeing the GPU and cutting encoder time on long files. It needs
whisper.cpp built with `WHISPER_COREML=1` and a model converted to CoreML,
which the packaged builds do not include. See
[whisper.cpp's CoreML instructions](https://github.com/ggml-org/whisper.cpp#core-ml-support)
to build it yourself, then point `stt.whisperCpp.binary` at the result.

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

A corrupted file passes its check -- it still exists -- so `doctor` cannot see
the problem. `ailoud setup --force` reinstalls everything regardless of what
the checks say, ffmpeg through every model, for exactly that case -- see the
[CLI reference](cli.md#setup) for what it costs with a local summariser.

## Concurrency

`setup` and `doctor --fix` take a lock on the data directory, so two runs
cannot download into the same path at once. A stale lock left by a crash is
taken over automatically.
