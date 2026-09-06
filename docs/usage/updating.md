# Updating ailoud

```shell
ailoud self update
```

`self update` asks the registry itself, so nothing has to be run before it. It
installs the newer version if there is one, then refreshes the rules block in
every registered project.

```shell
ailoud self check          # only look, change nothing
ailoud self check --json   # the same answer, for a script
ailoud self sync           # refresh the rules without updating
```

`self check` is for looking without installing; `self update` does not need
it.

## What counts as newer

| You are on      | Can move to                                           |
| --------------- | ----------------------------------------------------- |
| a final release | any newer final release                               |
| `X.Y.Z-dev.N`   | a newer `dev` of the same `X.Y.Z`, or any newer final |
| `X.Y.Z-rc.N`    | a newer `rc` of the same `X.Y.Z`, or any newer final  |

A deprecated version is never offered.

## Turning off the passive notice

Other commands mention an update at most once a day. `self check` and
`self update` themselves are unaffected by either switch.

```shell
export AILOUD_NO_UPDATE_CHECK=1
```

```yaml
update:
  check: false
```
