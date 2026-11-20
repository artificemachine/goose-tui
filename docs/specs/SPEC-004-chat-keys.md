# SPEC-004: Interrupting and leaving the chat

Status: draft
Last reviewed: 2026-11-20
Affected paths: src/acp/chat-ui.ts, src/acp/chat-config.ts

Esc is the "stop" key and Ctrl+C is the "leave" key. They used to overlap: with
an empty composer and no turn running, Esc closed the whole chat. This spec
pins the separation. Promotion to `approved` is the owner's act.

## Requirements

- [REQ-011] While a turn runs, Esc cancels that turn. While idle, Esc cancels nothing and explains once how to leave.
- [REQ-012] Ctrl+C closes the chat: the agent is stopped, the terminal is given back, and the process exits with status 0.
- [REQ-013] `/exit` and `/quit` close the chat the same way Ctrl+C does.
- [REQ-014] Once the agent has exited there is nothing left to cancel, so Esc and Ctrl+C both close the chat.

## Scoped Invariants

- [INV-104] While the agent is alive, Esc never closes the chat: not when idle, not during a turn, not while a new session title is being asked for.

## Verification & Validation

- REQ-011 -> tests/chat-keys.test.ts::esc_cancels_the_running_turn
- REQ-012 -> tests/chat-keys.test.ts::ctrl_c_exits_the_chat
- REQ-013 -> tests/chat-keys.test.ts::exit_command_closes_the_chat
- REQ-014 -> tests/chat-keys.test.ts::dead_agent_chat_closes_on_either_key
- INV-104 -> tests/chat-keys.test.ts::esc_never_exits_the_chat

## Not covered

The tests drive the input listener with the bytes a terminal sends; no real
terminal is involved. Esc inside a menu, a permission prompt or the
autocomplete list belongs to that component and is checked by
`scripts/acp-esc-key-test.ts` and `scripts/acp-overlay-test.ts`.
