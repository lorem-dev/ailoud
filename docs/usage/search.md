# Search

Find where something was said. Search returns the matching lines, not the
transcript.

```
ailoud audio search rollback
```

```
01M1B2W5EG  Backend standup  [standup, backend]  2 hits
  [00:01:02] Ben: I still think CI is too slow in general.
  [00:01:10] Ann: Agreed, but that is a separate problem.
```

## Phrases and prefixes

```
ailoud audio f "before sunrise"    # these words, adjacent
ailoud audio f "гаван*"            # any ending: гавани, гавань, гаванью
ailoud audio f rollback deploy     # both words, same line
```

A trailing `*` matters most in inflected languages, where a word has many
endings.

## Case and language

Search folds case in every language, Russian included:

```
ailoud audio f встреча     # finds "Встреча у пирса"
```

## Punctuation is safe

These are searches, not syntax errors:

```
ailoud audio f "don't"
ailoud audio f "C++"
ailoud audio f AND
```

## Narrow it

```
ailoud audio f rollback --tag release
ailoud audio f rollback --lang ru
ailoud audio f rollback --recording ID001
ailoud audio f rollback --limit 200
```

## Every transcript

By default only each recording's newest transcript is searched. A recording
re-transcribed with `--force` holds the same words twice, and returning both
looks like two occurrences.

```
ailoud audio f rollback --all
```

## For scripts

```
ailoud audio f rollback --json | jq '.[] | {at, text}'
```

```json
[
  {
    "recordingId": "01M1B2W5EG3SG628QEZCGAKP33",
    "startMs": 62000,
    "speaker": "Ben",
    "text": "I still think CI is too slow in general."
  }
]
```
