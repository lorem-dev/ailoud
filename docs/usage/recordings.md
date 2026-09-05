# Recordings

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

Several tags narrow. A recording must carry all of them.

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
