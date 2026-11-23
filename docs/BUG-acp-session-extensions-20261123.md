# Bug report — ACP session extension selection has no way to say "the profile"

Status: **open upstream** (written 2026-11-23, against goose `1.60.0`, commit `bf63bc0`).
Reported from `goose-tui` (rossii), an ACP client, after a user-visible failure: a session
created with a set that names no `developer` came up with **no file or shell tools**, and
the client had no request with which to repair it.

Keep this file as the canonical copy; the text below is what should be filed.

---

## Summary

`session/new` reads `_meta.enabledExtensions` as *the whole* extension list:

> A selection the client sends is the whole session: an empty list starts no extensions, and
> `[memory]` starts Memory without the default built-ins.
> — `crates/goose/src/acp/server.rs:621-623` (`initial_session_extensions`)

That is a defensible contract for a session builder, but it leaves two gaps that a client
cannot work around through ACP:

1. **No "profile plus/minus" selection.** A client can send a full list or nothing. There is
   no "start from `config.yaml` and remove one entry", and no reset-to-profile request: the
   session extension API is `list` / `add` / `remove`
   (`crates/goose-sdk-types/src/custom_requests.rs:34,43,619`). A client that wants goose's
   own profile must reconstruct it itself — see gap 2.
2. **The profile cannot be reconstructed from ACP.** `_goose/unstable/config/extensions/list`
   filters hidden platform extensions out
   (`crates/goose/src/acp/server/extensions.rs:41-48`, `is_hidden_extension`), so in 1.60.0
   `scheduler` and `orchestrator` never appear. A client rebuilding the profile from that RPC
   silently drops them.

A third consequence is worth a line in the docs: when `enabledExtensions` is present, the
standard ACP `mcpServers` field is **ignored** (`initial_session_extensions` returns early),
so `{enabledExtensions: [], mcpServers: [server]}` starts nothing at all, without an error.

## What the user sees

The agent answers "I can't read files / I only have `load_skill`" for the rest of the
session. Nothing in the protocol said the session was created without tools: the client asked
for an exact set, goose honoured it exactly, and the set simply had no `developer` in it.
The failure is silent on both sides.

## Evidence

Source (`1.60.0`):

- `crates/goose/src/acp/server.rs:612` `initial_session_extensions` — early return when
  `goose_extensions` is `Some`, comment quoted above.
- `crates/goose/src/acp/server.rs:2845` `requested_builtins_replace_default_selection` and
  `:2960` `empty_client_selection_starts_no_extensions` — the behaviour is pinned by tests, so
  this is design, not an accident.
- `crates/goose/src/acp/server/extensions.rs:41-48` — hidden extensions filtered from the
  config list.
- `crates/goose-sdk-types/src/custom_requests.rs:34,43,619` — `session/extensions/{add,
  remove,list}` and nothing else.

Measured against the installed `goose 1.60.0` (release build) with an ACP client speaking
JSON-RPC over stdio, listing each new session's extensions right after `session/new`:

```
A enabledExtensions: []                       -> (none)
B enabledExtensions: [] + mcpServers:[probe]  -> (none)
C enabledExtensions: [{builtin: developer}]
                    + mcpServers:[probe]      -> builtin:developer
D (no enabledExtensions field)                -> platform:analyze, platform:developer,
                                                 platform:todo, platform:chatrecall,
                                                 platform:code_execution,
                                                 platform:scheduler,
                                                 builtin:computercontroller,
                                                 builtin:autovisualiser, builtin:memory
```

Read those four lines together:

- **A** is the one that produces the user-visible failure: an empty selection leaves the
  session with *nothing*, not even `developer`, although `config.yaml` enables it. (The
  comment in `server.rs` says `[memory]` starts Memory "without the default built-ins" — an
  empty list therefore starts no built-ins at all, and there is no implicit `developer` to
  fall back on.)
- **B** and **C** show the silent half: `mcpServers` is dropped whenever the typed list is
  present, empty or not. No error, no warning, no entry in the response.
- **D** is what a client gets when it says nothing — the profile `goose session` would use,
  `scheduler` included.

And the profile cannot be rebuilt from the config list: the same binary answers
`_goose/unstable/config/extensions/list` with fourteen entries,
`platform:analyze, platform:tom, platform:summon, platform:summarize, platform:developer,
platform:apps, platform:todo, platform:chatrecall, platform:Extension Manager,
platform:code_execution, builtin:computercontroller, builtin:autovisualiser, builtin:memory,
builtin:tutorial` — **`scheduler` absent**, though the profile session in D has it.

`scripts/acp-client-smoke.ts` in this repository is the same experiment without a TUI; its
`enabledExtensions: []` session prints `(none)`, which the script currently reports as
"✅ the set is exact".

## Minimal reproduction

1. `session/new` with `_meta.enabledExtensions: []` and nothing else.
2. Ask the agent to read a file.
3. It cannot: the session has no `developer` extension, even though `config.yaml` enables it.
4. Repeat with `_meta.enabledExtensions: []` plus a standard
   `mcpServers: [{type: "stdio", name: "probe", command: "echo"}]`: the server is silently
   dropped as well.

## Expected

One of, in order of preference:

1. **A way to name the profile**: accept `"profile"` as a value of `enabledExtensions`, or add
   `_goose/unstable/session/extensions/reset`, so a client can say "the user's configuration,
   as `goose session` would have it". This is what a Default/new-session path actually wants.
2. **Report hidden extensions** from `config/extensions/list` (a `hidden: true` flag rather
   than a filter), so a client can reconstruct the profile exactly.
3. **Keep `mcpServers` as an addition** when `enabledExtensions` is present, instead of
   letting the typed list discard it, and/or reject the combination with
   `invalid_params` rather than starting a session with nothing.

Whichever is chosen, an empty selection that leaves a session without `developer` deserves a
warning in the `session/new` response: it is the one outcome no client asks for on purpose.

## Workaround used by this client

Documented in `AGENTS.md` under "Session sets in chat mode": read `config.yaml` to rebuild the
profile when the user selects Default, send the exact typed list for a set, and reconcile a
resumed session with `list`/`add`/`remove` — the config-list RPC is deliberately not used for
that, because it hides `scheduler` and `orchestrator`. Two limits remain and are reported to
the user in the chat: an inline-env stdio spec cannot be expressed at all (goose wants
`envKeys` into its secret store), and a set's `mcpServers` cannot ride alongside its typed
list, which is why this client still sends both channels and says so when only one lands.
