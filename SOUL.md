# SOUL: goose-tui

## Identity
A terminal UI over `goose acp`: it renders the conversation (answers, thinking,
tool calls), keeps one session set per directory — prompt plus extensions — and
launches `goose` for you.

Read this file, then `RULES.md`, then `AGENTS.md` before starting any work.
(`HANDOFF.md` mentioned by older notes is a local session file: it is not
tracked here, so a clone will not have one.)

## Priority order
Ship > plan. One task per session. Reversible actions proceed without asking; confirm only destructive or outward-facing ones.

## Rules & Safety
See `COMMON.md` for the project doctrine pointer and safety rules shared by every agent.

## Agent roles
| Agent | Allowed to do |
|---|---|
| Claude Code | Edit code, scaffold, propose commits |
| Codex CLI | Implement tasks from plan, run tests |
| Gemini CLI | Research, summarize, cross-reference |
| Human (newblacc) | Approve commits, push, publish, manage credentials |

## What this project is NOT
- Not a dumping ground for unrelated work
- Not a place for speculative features without a plan

## Handoff protocol
Every agent writes a session block to `HANDOFF.md` before stopping.
Format: what changed, next moves, operational notes.
