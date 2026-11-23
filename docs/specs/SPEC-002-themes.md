# SPEC-002: Colour themes

Status: draft
Last reviewed: 2026-11-23
Affected paths: src/theme.ts, src/acp/chat-config.ts

The chat can be shown in one of nine colour themes, chosen with `/theme <name>`
and remembered for the next start. One module, `src/theme.ts`, owns the palette
every other module prints with. Promotion to `approved` is the owner's act.

## Requirements

- [REQ-002] Choosing a theme applies it at once and saves its name to the file `theme` in the config directory; the next start loads that file and comes up in the same theme. Names are matched without regard to case.
- [REQ-003] An unknown theme name is refused: the current theme stays applied and the saved choice is left untouched.
- [REQ-004] The themes on offer are `default`, `goose`, `opencode`, `retrowave`, `retrowave2`, `monokai`, `dracula`, `nord` and `light`, and each can be selected. Applying a theme without a config directory writes nothing.
- [REQ-018] A theme that paints section bands keeps one slot per section, never a per-theme arrangement: answers on the darkest band (near-black, or a dark grey such as retrowave's `#222324` at L\* 13.7), tool calls on a blue band above it, shell output on the coloured band above that (the retrowave teal `#0081B0`, green in `monokai`) (the retrowave teal `#0081B0`, green in `monokai`), the user's own message on the one light (mauve) band. The three bands form a monotone ladder, each at least five L\* from the next; none climbs above L\* 55, so every one stays a band; and shell and tool calls remain separable either by a hue gap of 20° or a lightness step of 15 L\*, because their hue families may overlap. A band lighter than its inherited text — the teal one — names its own foreground, which clears 4.4:1 on it (the ceiling `#0081B0` allows with white). The user band sits far above the others and always carries a legible dark foreground, and the composer is a dark surface of its own, never one of the bands. Only the hue changes between such themes, so a section keeps its rank and its meaning when the theme changes. The status strip is not a band: it paints no background (the terminal shows through) and its chips are the neutral grey ladder of `STATUS_CHIPS`, identical in every theme, so only the strip's text takes the theme's colour. That text clears 4.5:1 against every chip.
- [REQ-019] No theme draws a frame around the surfaces it colours: the conversation is rendered without rounded corners and without side bars, and the composer without vertical edges, in every theme including the ones that paint no bands.

## Scoped Invariants

- [INV-102] A start never fails because of the saved theme: a missing file gives `default` silently, and an unknown saved name gives `default` with a warning on stderr that names the file.

## Verification & Validation

- REQ-002 -> tests/theme.test.ts::theme_choice_is_saved_and_restored
- REQ-003 -> tests/theme.test.ts::unknown_theme_is_refused_and_changes_nothing
- REQ-004 -> tests/theme.test.ts::every_listed_theme_can_be_selected
- INV-102 -> tests/theme.test.ts::unusable_saved_theme_falls_back_to_default
- REQ-018 -> tests/theme.test.ts::every_chrome_theme_keeps_a_three_step_band_ladder
- REQ-018 -> tests/theme.test.ts::every_chrome_theme_keeps_each_section_on_its_own_colour
- REQ-018 -> tests/theme.test.ts::the_user_band_carries_a_legible_foreground
- REQ-018 -> tests/theme.test.ts::the_shell_band_carries_a_legible_foreground_when_it_is_a_mid_tone
- REQ-018 -> tests/theme.test.ts::the_status_chips_are_the_reference_neutral_ladder
- REQ-018 -> tests/theme.test.ts::the_status_text_clears_aa_on_every_chip
- REQ-019 -> tests/surfaces.test.ts::the_conversation_renders_without_a_frame

## Not covered

The pixels: `scripts/theme-surface-test.ts` checks that the composer, the status
strip and each band actually render with the active theme's colours, and that no
theme without chrome paints one. A saved theme file that exists but cannot be
read is handled in the code and has no test.
