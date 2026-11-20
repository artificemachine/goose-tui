# SPEC-003: Browser surface

Status: draft
Last reviewed: 2026-11-20
Affected paths: src/web/server.ts, src/web/main.ts, src/web/engine.ts

`goose-tui web` serves the same goose session to a browser: one page, one event
stream, and three small endpoints. The page is a remote control for an agent
that can run shell commands, so where the server listens is part of the
contract. Promotion to `approved` is the owner's act.

## Requirements

- [REQ-005] `GET /health` answers 200 with `{ok: true, busy}`, where `busy` says whether a turn is running.
- [REQ-006] `POST /prompt` with a non-empty string `text` answers 202 `{accepted: true}` and hands the text to the agent. A body that is not JSON answers 400 `body must be JSON`; a missing, non-string or blank `text` answers 400 `text is required`. A refused prompt never reaches the agent.
- [REQ-007] `POST /cancel` answers 202 and cancels the running turn.
- [REQ-008] `GET /events` is a `text/event-stream` that opens with `: connected` and then carries every engine event as one `data:` line of JSON. A stream the browser closes is dropped from the set of open streams.
- [REQ-009] Any other path, or a known path with the wrong method, answers 404 `{error: "not found"}`.
- [REQ-010] A port that is not an integer between 0 and 65535 is refused with `goose-tui web: invalid port` before anything is bound.

## Scoped Invariants

- [INV-103] Unless the operator names another host (`--host` or `HOST`), the server listens on `127.0.0.1` only.

## Verification & Validation

- REQ-005 -> tests/web.test.ts::health_reports_whether_a_turn_is_running
- REQ-006 -> tests/web.test.ts::prompt_is_accepted_or_refused_with_a_reason
- REQ-007 -> tests/web.test.ts::cancel_reaches_the_engine
- REQ-008 -> tests/web.test.ts::event_stream_carries_engine_events_to_the_browser
- REQ-009 -> tests/web.test.ts::unknown_route_is_not_found
- REQ-010 -> tests/web.test.ts::invalid_port_is_refused_before_binding
- INV-103 -> tests/web.test.ts::web_binds_loopback_unless_told_otherwise

## Not covered

The server has no authentication, no origin check and no limit on the size of a
prompt. Anyone who can reach the port controls the agent, which is why INV-103
exists; binding another host is the operator's decision and nothing here makes
it safe. The page itself (`GET /`) and a real turn against goose are exercised
by `scripts/web-server-test.ts`, not by a requirement here.
