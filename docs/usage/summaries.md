# Summaries

A summary is written by a language model and saved as a **report**.

```
ailoud audio summarize ID001
```

There is no default selection. Name the recordings, or a tag:

```
ailoud audio summarize ID001 ID002
ailoud audio summarize --tag standup
```

## Shape it

```
ailoud audio summarize ID001 --template one-on-one
```

The headings change with the template. See [Templates](templates.md).

## Tell it what the transcript does not say

```
ailoud audio summarize ID001 \
  --template one-on-one \
  --context "Ann is Ben's manager; this is their fortnightly."
```

Keep it to a sentence or two. Every word competes with the transcript for the
model's attention.

## Choose the language

```
ailoud audio summarize ID001 --lang en
```

Without `--lang`, the summary is written in the language of the recording.

## Groups

Several recordings become **one** report, not several stapled together:

```
ailoud audio summarize --tag offsite
```

A group reuses each recording's stored report instead of re-reading its
transcript, which is much cheaper. Force a fresh read:

```
ailoud audio summarize --tag offsite --fresh
```

A single recording is always read from its transcript. A summary of a summary
drifts.

## Reports

```
ailoud report ls
ailoud report ls --recording ID001
ailoud report show SUM0
ailoud report rm SUM0
```

```
SUM0AB...  2026.08.31 12:54  haiku  ru  01M1B2W5EG  Встреча у пирса в 5:00
```

Each report records the template it used, the context it was given and the
model that wrote it.

Deleting a report leaves the recording and its transcript alone. You can make
it again.

## Which model

Set `llm.provider` in the [config file](configuration.md#language-model):

| Provider            | Reaches                                                  | Credential          |
| ------------------- | -------------------------------------------------------- | ------------------- |
| `llama-cpp`         | a local GGUF model                                       | none                |
| `claude-cli`        | Claude via [Claude Code](https://claude.com/claude-code) | its own sign-in     |
| `anthropic`         | [Claude API](https://docs.claude.com/en/api/overview)    | `ANTHROPIC_API_KEY` |
| `openai-compatible` | OpenAI, Ollama, LM Studio                                | `OPENAI_API_KEY`    |

`ailoud setup` asks and writes the answer for you.

## Long recordings

A transcript too long for the model is summarised in portions and the answers
combined. You see the progress:

```
Summarising portion 3/8 (37%)
```
