# Plan: Retrowave theme for rossii

## 1. Scope summary

Add the Retrowave visual theme inspired by Goose PR #5831: role-based colors for the prompt background and border, while keeping the existing pi-tui editor and `/theme` selection. Not a reproduction of the entire Rust interface. Smallest v1: a selectable, persistent Retrowave theme with a distinct prompt background and border. Source: https://github.com/aaif-goose/goose/pull/5831 and `docs/REPORT-goose-tui-continuations-20261119.md`. Register: none found in `docs/`.

## 2. Prerequisites

- Bun and installed dependencies; a terminal supporting truecolor for visual verification. No live provider or goose connection for automated tests.
- Base revision `71390ffea4db0dfa1ec092bd3fa18a6d57aab6a9`; existing uncommitted theme work is part of the starting tree and must be preserved. `bun run test:theme` passed 10 checks twice. Full-suite baseline is unverified.
- Read `src/theme.ts`, `src/acp/chat-ui.ts`, `src/acp/chat-context.ts`, `src/acp/chat-config.ts`, `scripts/theme-test.ts`, and project README policy before editing. Verify the current `setTheme` and `runThemeCommand` implementations before reusing them.
- Verify Apache-2.0 attribution for the PR's palette and existing README credits. Treat source color values as data; do not copy Rust renderer code.
- Checker: `python3 /path/to/skills-canonical/tools/plan_check.py <plan> --caller plan-implement --repo-root .`; Python 3.11.6 and checker file exist. The canonical repository environment variable was unset; confirm the installed canonical skills repository before execution.
- Execution architecture: sequential, condition 1: a single ready slice. Both delegated and sequential execution would edit the same theme and rendering interfaces; one slice avoids integration churn. No subagent is required.
- Risks: theme switching must invalidate render caches; editor wrapping must retain focus, keyboard input, IME and mouse routing. Retained transcript strings may contain old ANSI styles. Visual rendering on terminal and modes needs actual verification.

## 3. Iterations

#### Iteration 1 — Retrowave prompt surface

**Goal:** Deliver selectable Retrowave with a colored prompt background and border, without changing default rendering.

**Shippable on its own?** Yes.

**Source references:**
- `src/theme.ts` — existing color palette, persistence, compatibility.
- `src/acp/chat-ui.ts` — editor, layout and renderer construction.
- `src/acp/chat-context.ts` — editor theme callbacks.
- `src/acp/chat-config.ts` — existing command and invalidation path.
- `scripts/theme-test.ts` — existing regression tests.
- `README.md` — theme documentation and source credit; inspect repository policy before changing.
- `docs/REPORT-goose-tui-continuations-20261119.md` — upstream PR palette reference; verify license and source values before adapting.

**Files touched:**
- `src/theme.ts` (modified)
- `src/acp/chat-ui.ts` (modified)
- `src/acp/chat-context.ts` (modified)
- `src/acp/chat-config.ts` (modified if invalidation requires it)
- `scripts/theme-test.ts` (modified)
- `scripts/theme-surface-test.ts` (new)
- `README.md` (modified)

**Commit message:**
`feat(theme): add retrowave prompt surface`

**TDD cycle:**
- RED (failing tests to write first):
  - `scripts/theme-test.ts::retrowave selection and persistence` — selecting and restoring the new name works.
  - `scripts/theme-surface-test.ts::prompt background and border` — the actual rendered editor includes the selected background and border; default does not change.
  - `scripts/theme-surface-test.ts::live switch and focus` — switching theme invalidates the surface while editor input and focus survive.
- GREEN (minimal implementation to pass RED):
  - Extend existing theme representation with explicit surface roles and verified Retrowave colors; use terminal default for `default` and existing themes.
  - Apply the surface to pi-tui editor through a composable wrapper or existing component, preserving input, focus, cursor and mouse; connect `/theme` switch to render invalidation.
  - Preserve existing names, behavior, saved files and existing history. Credit the source in `README.md`.
- REFACTOR (cleanup planned after GREEN):
  - Extract a focused surface styling helper only if needed to avoid repeated ANSI handling.

**Test pyramid for this iteration:**
- Smoke: instantiate the surface/editor in a synthetic terminal.
- Unit: palette roles, defaults, ANSI reset and persistence in the two named scripts.
- Integration: real pi-tui Editor surface rendering, focus and live switching with synthetic terminal.
- State machine: default → retrowave → default and input focus transitions.
- Contract: named palette role values valid hex; saved theme compatible with existing reader.
- Regression: 10 existing `scripts/theme-test.ts` checks; no behavior change for existing themes.
- Chaos: invalid theme preserves existing selection; narrow rendering and nested ANSI resets.
- E2E: manually run local chat in isolated environment, select `/theme retrowave`, type, switch back and restart; do not use user data or live provider without separate permission.
- Performance: N/A — no performance acceptance threshold.
- TDD Parity: new selection and rendered surface plus live switching each have an observed RED and GREEN; manual visual check is separately reported.
- Coverage: baseline and delta unknown; do not invent a percentage or weaken any configured threshold.

**Deploy + validate:**
- Install: N/A — run repository source without installation.
- Validate: from repository root run `bun run test:theme && bun scripts/theme-surface-test.ts`; both exit 0. Run `bun run test` and report any pre-existing environment failure without hiding it. Manual terminal E2E is separate; report skipped if no safe isolated setup is available.
- Rollback: N/A — leave uncommitted changes for review; revert only after explicit authorization, preserving pre-existing dirty files.

**Side-effect fence:** Only listed repository files and synthetic temporary test fixtures. No real config, live API, secrets, global config, commit or deploy.

**Checkpoint evidence:** Record base revision, pre-existing diff, exact RED/GREEN outputs, affected paths, manual result and test-suite limitations. Append an execution record beside the saved plan if no task system is available.

**Acceptance criteria (binary):**
- [ ] `/theme retrowave` selects and persists the new palette without replacing existing theme names.
- [ ] Retrowave renders the prompt background and border; switching back restores the original surface.
- [ ] Focus, editing and keyboard handling remain functional after switching; automated tests pass.
- [ ] README credits the upstream project, URL, license, and palette use.

**Estimated effort:** XS (30–60 min; basis: one palette and editor surface with focused integration tests; stop at 120 min active work)

**Executor:** default

**Isolation:** shared

**Delegation:** in-session

**Blocked by:** None

## 4. Test inventory summary

| Iter | Smoke | Unit | Integration | State machine | Contract | Regression | Chaos | E2E | Performance | TDD Parity | Coverage Δ |
|------|-------|------|-------------|---------------|----------|------------|-------|-----|-------------|------------|------------|
| 1 | 1 | 3+ | 1 | 2 paths | 1 | existing 10 | 2 | 1 manual | N/A | new behaviors | unknown |

## 4b. Effort summary

| Iter | Size | Duration | Basis |
|------|------|----------|-------|
| 1 | XS | 30–60 min | Palette, live UI surface, focus, tests and review |

**Estimated total:** 30–60 min active work; manual environment or approval waiting excluded. Sanity check: bounded to one theme and existing editor; terminal rendering remains the main uncertainty.

## 5. End-to-end definition of done

- Select and persist Retrowave, observe distinct prompt background and border, type normally, switch back, restart and confirm persistence.
- Existing themes and default remain unchanged; source credited; errors and skipped manual steps reported.
- From repository root: `bun scripts/theme-test.ts && bun scripts/theme-surface-test.ts && bun run test`.
- Manual demo in an isolated configuration with no real credentials; if live goose is unavailable, explicitly mark E2E unverified rather than claiming success.

## 6. Out of scope

- Full Rust layout parity — extra design and implementation beyond the first usable theme.
- Gemini and Goose 5831 themes — validate the rendering approach with Retrowave first.
- Terminal-wide background changes and automatic light/dark detection — terminal-dependent and not needed for v1.
- Security fixes and shipping — separate work and authorization.

## 7. Open questions

None.
