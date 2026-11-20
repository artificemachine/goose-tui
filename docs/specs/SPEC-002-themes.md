# SPEC-002: Colour themes

Status: draft
Last reviewed: 2026-11-20
Affected paths: src/theme.ts, src/acp/chat-config.ts

The chat can be shown in one of seven colour themes, chosen with `/theme <name>`
and remembered for the next start. One module, `src/theme.ts`, owns the palette
every other module prints with. Promotion to `approved` is the owner's act.

## Requirements

- [REQ-002] Choosing a theme applies it at once and saves its name to the file `theme` in the config directory; the next start loads that file and comes up in the same theme. Names are matched without regard to case.
- [REQ-003] An unknown theme name is refused: the current theme stays applied and the saved choice is left untouched.
- [REQ-004] The themes on offer are `default`, `goose`, `opencode`, `retrowave`, `dracula`, `nord` and `light`, and each can be selected. Applying a theme without a config directory writes nothing.

## Scoped Invariants

- [INV-102] A start never fails because of the saved theme: a missing file gives `default` silently, and an unknown saved name gives `default` with a warning on stderr that names the file.

## Verification & Validation

- REQ-002 -> tests/theme.test.ts::theme_choice_is_saved_and_restored
- REQ-003 -> tests/theme.test.ts::unknown_theme_is_refused_and_changes_nothing
- REQ-004 -> tests/theme.test.ts::every_listed_theme_can_be_selected
- INV-102 -> tests/theme.test.ts::unusable_saved_theme_falls_back_to_default

## Not covered

How a theme looks (the retrowave frame, the bands around answers, thoughts and
tool calls) is checked by `scripts/theme-test.ts` and
`scripts/theme-surface-test.ts`, not by a requirement here. A saved theme file
that exists but cannot be read is handled in the code and has no test.
