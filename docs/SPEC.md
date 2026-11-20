# Specification: goose-tui

This file is the system index for this project's specifications. One row per
spec below; each specification lives beside it under `docs/specs/`.

## Problem
Goose dropped its own terminal UI, and the independent client that replaced it,
`rossii`, lacks things its users here need: a readable colour theme, a way to
reach the same session from a browser, an Esc key that cannot close the chat by
accident, and a durable record of what went wrong. goose-tui is a fork of rossii
that adds those while staying mergeable with it.

## Scope
Included: the `/theme` command and its themes, the `goose-tui web` browser
surface, the Esc and `/exit` behaviour, the `bin/goose-tui` launcher, the
`goose-tui` display name, and the error journal.

Excluded: renaming identifiers, data paths or environment variables away from
`rossii`; publishing releases or installers; changing goose itself.

## Constraints
- `git merge upstream/main` stays trivial: upstream files change as little as possible.
- The repository is public, so nothing private is committed.
- The browser surface binds `127.0.0.1` unless the operator chooses another host: the page controls an agent that can run shell commands.
- Runtime: Bun and a goose build with the `acp` subcommand. Linux and macOS only.

## Failure Reporting
Fixed constraints, inherited by every spec in this project. They are not a
placeholder to fill in: they hold as written, and `INVARIANTS.md` binds each one
to a test.

- Every error leaves a persistent trace, with an explanation when one is known. No partial failure is ever reported as success.
- Every confirmed bug, gap, invariant violation and persistent failure gets a written report in the repo and becomes a private issue on the project's tracker (GitLab, GitHub or OpenProject), deduplicated, labelled `AI-gen`.
- No secret ever reaches a log or an issue. When the tracker is unreachable, write a local report and queue the publication.

## Acceptance
- `bun run check` and `bun run test` pass, apart from failures the report names as environmental.
- `bash tests/doctrine/doctrine-guard.sh` reports no failure.
- Every requirement and invariant below is bound to a test that exists.

## Specifications

One row per specification: identifier, title, path, status. A row whose status
is `superseded` must also name its successor with `-> SPEC-<nnn>` so
traceability has no silent dead end. Every path resolves to an existing file
under `docs/specs/`.

- [SPEC-001] Project foundation contract (docs/specs/SPEC-001-project-foundation.md) status: draft
