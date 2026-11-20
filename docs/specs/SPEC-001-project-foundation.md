# SPEC-001: Project foundation contract

Status: draft
Last reviewed: 2026-11-20
Affected paths: src/journal.ts

This spec holds the project-wide contract every later specification builds on:
the error journal (`src/journal.ts`) that the baseline invariants of
`INVARIANTS.md` rely on. Promotion to `approved` is the owner's act, never the
guard's or an agent's.

## Requirements

One row per requirement; the identifier is globally unique across every spec
in this project.

- [REQ-001] The state directory, the journal file, the reports directory and every report are readable and writable by their owner only (directories 0700, files 0600).

## Scoped Invariants

One row per invariant scoped to this spec, using the same binding format as
`INVARIANTS.md`. Identifiers stay globally unique project-wide; this scaffold
starts at `INV-101` to leave the registry's `INV-4` onward untouched.

- [INV-101] Journaling an error never throws into its caller; when the journal cannot be written, that is announced on stderr together with the error it was carrying.

## Verification & Validation

One row per requirement and scoped invariant, bound to the test that proves
it: `tests/<file>[::<test>]`.

- REQ-001 -> tests/journal.test.ts::journal_files_are_owner_only
- INV-101 -> tests/journal.test.ts::journal_failure_never_throws
