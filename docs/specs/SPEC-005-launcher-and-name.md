# SPEC-005: Launcher and name

Status: draft
Last reviewed: 2026-11-20
Affected paths: bin/goose-tui, src/acp/session-meta.ts

`bin/goose-tui` starts the chat from any directory, typically through a link on
the user's PATH. The project shows itself as goose-tui while every identifier
it shares with upstream stays `rossii`; that second half is project-wide and is
bound as INV-4 in `INVARIANTS.md`. Promotion to `approved` is the owner's act.

## Requirements

- [REQ-015] The launcher finds its checkout by following its own symbolic links, relative or absolute, however many there are, and passes its arguments through unchanged.
- [REQ-016] `GOOSE_TUI_ROOT` replaces the checkout the launcher runs from.
- [REQ-017] When the chosen checkout has no `src/index.ts`, the launcher exits with status 1, prints nothing on stdout, and says on stderr which directory it looked in.

## Scoped Invariants

None. The invariant this feature touches is project-wide: see INV-4.

## Verification & Validation

- REQ-015 -> tests/launcher.test.ts::launcher_runs_from_anywhere_through_a_symlink
- REQ-016 -> tests/launcher.test.ts::launcher_root_can_be_overridden
- REQ-017 -> tests/launcher.test.ts::launcher_refuses_a_root_without_an_entry_point

## Not covered

The launcher also refuses to run when `bun` is not on PATH; that branch has no
test. The display name in the help text, the banner and `doctor` is not bound
to a requirement.
