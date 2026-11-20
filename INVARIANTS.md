# Invariants: goose-tui

An invariant is a property that must hold after every operation, stated so that a
test can falsify it. A rule nothing tests is doctrine, not an invariant, so every
row below binds to the test that guards it.

Row format, parsed by `tests/doctrine/doctrine-guard.sh`:

```
INV-<n>: <statement> [(baseline)] -> tests/<file>[::[<Class>::]<test_name>[[<param>]]]
```

The binding is `<!-- PLACEHOLDER -->` until the test exists. The guard tolerates a
placeholder while the project has no tracked source, and refuses one afterwards.
Rows tagged `(baseline)` ship with every project and are not the project's own work;
`stateful` projects must add at least one row of their own, numbered from `INV-4`.

This registry stays project-wide: baseline rows and cross-cutting invariants about
the whole project live here. Invariants scoped to one specification live in that
spec's file under `docs/specs/`, with `INV-*` identifiers that stay globally unique
across the project and the same binding format. Never duplicate a scoped row here.
The guard enforces scoped rows through `--check traceability`, with the same
placeholder tolerance and test-target resolution as this registry.

## Invariants

- [INV-1] Every error leaves a persistent trace, with an explanation when one is known, and no partial failure is ever reported as success. (baseline) -> tests/journal.test.ts::error_leaves_a_persistent_trace
- [INV-2] Every confirmed bug, gap, invariant violation and persistent failure gets a written report in the repo and becomes a private issue on the project's tracker (GitLab, GitHub or OpenProject), deduplicated, labelled `AI-gen`. (baseline) -> tests/journal.test.ts::confirmed_failure_is_reported_once_and_queued
- [INV-3] No secret ever reaches a log or an issue, and when the tracker is unreachable the report is written locally and the publication queued. (baseline) -> tests/journal.test.ts::secret_never_reaches_the_journal

Add this project's own invariants below, starting at `INV-4`: one line each, stating
what must hold about the data this project owns, bound to the test that proves it.

## What the bindings prove

- INV-1: the fatal handler, a failed chat turn, a failed ACP setup, an agent that exits and a failed browser turn all call the journal, and a failed turn is announced as an error, never as done. A failure the code swallows without calling the journal is outside what the test can see.
- INV-2: each distinct failure gets one local report, counted and labelled `AI-gen`, with `published: false`. Turning a report into an issue on a tracker is a step a person or an agent performs; no code here publishes one.
- INV-3: secret values from the environment and bearer tokens are redacted before anything is written.
