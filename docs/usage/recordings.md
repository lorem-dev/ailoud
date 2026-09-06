# Recordings

## Flags

Where a flag means different things to different verbs, it gets a row each.

| Flag                     | Verb             | Does                                                                                               |
| ------------------------ | ---------------- | -------------------------------------------------------------------------------------------------- |
| `--tag <tag>`            | import           | tag the imported recordings; repeatable                                                            |
| `--tag <tag>`            | transcribe       | group these recordings under a tag; repeatable                                                     |
| `--tag <tag>`            | annotate         | group this recording under a tag; repeatable                                                       |
| `--tag <tag>`            | ls               | only recordings carrying this tag; repeatable                                                      |
| `--title <text>`         | import, annotate | the recording's title                                                                              |
| `--notes <text>`         | import, annotate | free-form context about the recording                                                              |
| `--lang <codes>`         | transcribe       | spoken language, several comma-separated, or `auto`. Naming two or more turns on multilingual mode |
| `--multilingual`         | transcribe       | segment by speech and language, transcribing each run separately                                   |
| `--model <name>`         | transcribe       | override the configured model                                                                      |
| `--diarize`              | transcribe       | attribute segments to speakers                                                                     |
| `--speakers <n>`         | transcribe       | known number of speakers, to help the diarizer                                                     |
| `--speakers`             | show             | list who spoke, instead of the transcript -- takes no value                                        |
| `--speaker <label=name>` | annotate         | a real name for one diarizer label; repeatable                                                     |
| `--speaker <who>`        | show             | only this speaker, by label or by the name you gave them                                           |
| `--transcript <id>`      | show             | a specific transcript instead of the newest; a prefix will do                                      |
| `--format <format>`      | show             | `text`, `json`, `srt`, `vtt` (default `text`)                                                      |
| `--json`                 | ls               | print one JSON array of rows instead of a table                                                    |
| `--force`                | transcribe       | re-transcribe recordings that already have a transcript                                            |
| `--force`                | rm               | delete without asking                                                                              |

## Import

```
ailoud audio import ~/Recordings/standup.m4a --tag standup
ailoud audio import ~/Recordings --tag offsite --tag 2026
```

A directory imports the media files directly inside it. It does not walk
subdirectories.

The file you point at is never moved or changed. AILoud keeps its own copy.

!!! tip "Always pass `--tag`"

    Tags are how you find a recording later by context. The easiest moment to
    add one is now, while you know what the file is. See [Tags](#tags).

## Transcribe

```
ailoud audio transcribe                 # everything with no transcript yet
ailoud audio transcribe ID001 ID002
ailoud audio transcribe ID001 --force   # redo one
```

Takes minutes per recording, roughly a tenth of the audio length.

### Two languages in one recording

```
ailoud audio transcribe ID001 --lang ru,en
```

Two or more languages turn on per-segment detection and confine it to that
set. One language forces it for the whole file:

```
ailoud audio transcribe ID001 --lang ru
```

Check what it found:

```
ailoud audio ls
```

```
01M1B2W5EG  00:36  ru+en  "Так, deploy pipeline зелёный..."
```

### Speakers

```
ailoud audio transcribe ID001 --diarize
ailoud audio transcribe ID001 --diarize --speakers 2
```

Speakers come out as `speaker_00`, `speaker_01`. Give them names:

```
ailoud audio show ID001 --speakers
ailoud audio annotate ID001 --speaker speaker_00=Ann --speaker speaker_01=Ben
```

Names survive `--force`, so re-transcribing does not lose them.

## Read

```
ailoud audio show ID001
ailoud audio show ID001 --speaker Ann
ailoud audio show ID001 --format srt > standup.srt
ailoud audio show ID001 --format json | jq '.segments[0]'
```

Formats: `text`, `json`, `srt`, `vtt`.

Output longer than 30 lines opens in your pager. `q` quits.

## Tags

```
ailoud audio annotate ID001 --tag release --tag backend
ailoud audio ls --tag release
ailoud audio ls --tag release --tag backend   # both, not either
```

## Titles and notes

```
ailoud audio annotate ID001 --title "Backend standup" --notes "Ann was late"
```

## Delete

```
ailoud audio rm ID001
ailoud audio rm ID001 --force   # no question
```

Deletes the recording, its transcripts, its reports and AILoud's copy of the
audio. **The file you imported from is not touched.**

## Short forms

Every verb has a one-letter alias, and the letter means the same thing in
every group:

```
ailoud audio i ~/Recordings   # import
ailoud audio t                # transcribe
ailoud audio f "rollback"     # search (find)
ailoud audio s ID001          # summarize
ailoud audio l                # ls
ailoud audio v ID001          # show (view)
ailoud audio a ID001 --tag x  # annotate
ailoud audio r ID001          # rm
```

The old top-level spellings still work: `ailoud ls`, `ailoud show`,
`ailoud import`, and so on.

See the full list in the [CLI Reference](cli.md).
