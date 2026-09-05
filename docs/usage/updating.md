# Updating ailoud

```shell
ailoud self check
ailoud self update
ailoud self sync
```

`self check` asks the registry whether a newer version exists. `self update`
installs it, then refreshes the rules block in every registered project.
`self sync` refreshes those rules on their own, without updating.

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
