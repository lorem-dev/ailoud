---
name: check-fixtures
description: >
  Drive the built ailoud binary against fixtures/ end to end -- import,
  transcribe, ls, show, and doctor -- in a throwaway HOME, XDG_CONFIG_HOME,
  and XDG_DATA_HOME, and confirm the working tree stays clean afterward.
---

# check-fixtures

The unit tests cover the domain core against fakes (`MemFs`, `FakeClock`,
`FakeIds`, `FakeStt`). This skill covers the layer they cannot: the real
`ailoud` binary, against real audio, writing to a real filesystem (inside a
sandbox). It is the only check that would catch a regression living in the
wiring between the CLI, the providers, and the filesystem -- for example a
provider writing to the wrong data directory, or a pipeline that behaves
differently once it is not driven by an in-memory port.

`fixtures/` (short audio samples with reference transcripts) and the Jest
end-to-end suite that drives the binary against them both exist. Six of the
twelve specs need a real `whisper-cli` binary and model file to pass; on a
machine without them, those specs fail loudly naming the missing binary,
and that is expected, not a regression -- see "Read the failures with the
right lens" below.

## What this covers

Three short fixtures, each with a reference transcript: an English clip, a
Russian clip, and a clip that mixes both languages. The suite drives:

- `ailoud doctor` against a sandbox with no config, and again after
  configuring the model.
- `ailoud import` against a fixture file, including the "already present"
  path on a repeat import.
- `ailoud transcribe`, checked by word error rate against the reference
  transcript rather than exact string equality -- a model or quantization
  change shifts wording by a word or two without being a regression.
- `ailoud show` in both `srt` and `json` formats, plus its error paths (a
  missing id, an unsupported `--format`).

## Isolation

The suite must never touch the developer's machine state. Every invocation
of the built binary sets all three of:

- `XDG_CONFIG_HOME`, which relocates `config.yaml`.
- `XDG_DATA_HOME`, which relocates `ailoud.db` and the `media/` tree.
- `HOME`, so nothing the process resolves relative to the real home
  directory (for example a fallback default when an XDG variable is
  unset) can reach outside the sandbox.

All three matter, and forgetting any one of them would let a run mutate
the developer's real library -- which is why the harness sets them for
every invocation rather than leaving it to each spec.

## Steps

### 1. Run the suite

```bash
pnpm test:e2e
```

That is the whole check: it builds the CLI, then runs the Jest specs
against the fixtures in a fresh sandboxed `HOME`, `XDG_CONFIG_HOME`, and
`XDG_DATA_HOME` per test.

### 2. Read the failures with the right lens

Six of the twelve specs need a real `whisper-cli` binary and model file.
On a machine without them, expect exactly those six to fail, each naming
the missing binary (for example "brew install whisper-cpp" or "not found
on PATH") -- that is environmental, not a regression, and is not a reason
to skip or delete the specs.

Beyond that: a failure in the fixtures themselves (missing file, corrupt
audio, a reference transcript that no longer matches any reasonable
transcription) means the fixture drifted or was never generated correctly.
A failure anywhere else means the product changed -- the pipeline, a
provider, or the CLI's command surface moved in a way the suite is telling
you about.

### 3. Confirm nothing escaped the sandbox

```bash
git status --porcelain   # expect clean
```

Every spec runs the CLI with a throwaway `HOME`, `XDG_CONFIG_HOME`, and
`XDG_DATA_HOME`, so a dirty tree here means a test wrote somewhere it
should not have. That is a blocker, and it is a harness defect, not a
product defect -- the fix belongs in the sandbox setup (`e2e/src/cli.ts`),
not in application code.

## Report

Summarize rather than restate Jest's own output:

```
pnpm test:e2e:            PASS / FAIL (N passed, N failed)
failing spec(s):          <file> -> <test name>
attributed to:            missing whisper-cli / fixture drift / product change / harness defect
working tree clean after: yes / no
```

For each failure give the test name, the assertion Jest printed, and which
of the four causes it is.
