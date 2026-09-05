# Templates

A template decides the **headings** of a summary. Different conversations
divide differently.

```
ailoud template ls
```

```
architecture-planning  design discussion -- decisions, options weighed, trade-offs, risks
meeting                the default shape: decisions, open questions, notes
offsite                offsite or workshop -- themes, decisions, actions
one-on-one             a private 1:1 -- agreements, concerns, follow-ups
performance-review     performance review -- evidence, agreed goals, disagreements
solution-decision      choosing between solutions -- decision, reasoning, what was rejected
```

## What each one produces

| Template                | Headings                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `meeting`               | Decisions / Open questions / Notes                                                             |
| `one-on-one`            | Agreements / Concerns raised / Follow-ups / Notes                                              |
| `performance-review`    | Strengths cited / Areas for improvement / Evidence and examples / Agreed goals / Disagreements |
| `architecture-planning` | Decisions / Options considered / Trade-offs / Risks / Open questions                           |
| `solution-decision`     | Decision / Reasoning / Rejected alternatives / What would change this decision / Next steps    |
| `offsite`               | Themes / Decisions / Actions / Notes                                                           |

## Use one

```
ailoud audio summarize ID001 --template solution-decision
```

## Read one

```
ailoud template show solution-decision
```

```yaml
summary: choosing between solutions -- decision, reasoning, what was rejected
context: This conversation is choosing between specific solutions. The decision,
  the reasoning behind it, and what was rejected are the whole point; record
  what would change the decision if it turned out to be wrong.
headings:
  - Decision
  - Reasoning
  - Rejected alternatives
  - What would change this decision
  - Next steps
```

## Edit one

Templates are files in `$XDG_CONFIG_HOME/ailoud/templates/`, one YAML each.
Edit a file and the change takes effect. AILoud never overwrites a file you
have edited.

```
$EDITOR ~/.config/ailoud/templates/one-on-one.yaml
```

## Write your own

```
ailoud template new sprint-retro \
  --context "This is a sprint retrospective." \
  --heading "Went well" \
  --heading "Did not go well" \
  --heading "Actions" \
  --summary "sprint retro"
```

Start from an existing one:

```
ailoud template new skip-level --from one-on-one
```

Then:

```
ailoud audio summarize ID001 --template sprint-retro
```

A template needs a `context` sentence and at least two headings. One heading
is a title, not a shape.

!!! tip

    Before writing a template, try `--context` on an existing one. It adjusts
    a summary without adding a shape you then have to maintain.
