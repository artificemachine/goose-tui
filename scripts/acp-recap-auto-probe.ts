#!/usr/bin/env bun
/**
 * Live probe for the **automatic** recap — real agent, real timer, no TUI.
 *
 * The chat's own path, driven end to end against `goose acp`:
 *
 *   `finishTurn` arms `armAutoRecap` → the timer fires → `submitQuietRecap`
 *   sends `/recap` → goose answers `※ recap: …` → `handleSessionUpdate` routes
 *   it to `ctx.recapLine` and opens no answer block.
 *
 * The transcript here is a real pi-tui `Container` and the timer is the real one;
 * only the terminal is stubbed (`tui`, `loader`, `editor`), because a probe has no
 * screen. The one thing the probe *sets up* rather than earns is the turn count:
 * `minSessionTurns` needs three, and paying for three real turns to prove a timer
 * would be silly — it is set explicitly and printed.
 *
 *   bun scripts/acp-recap-auto-probe.ts
 */

import { Container } from "@earendil-works/pi-tui";
import { AcpClient } from "../src/acp/client";
import { newSessionMeta } from "../src/acp/session-meta";
import { createChatContext } from "../src/acp/chat-context";
import { handleSessionUpdate } from "../src/acp/chat-stream";
import { submitPrompt } from "../src/acp/chat-io";
import { setPromptHandlers } from "../src/acp/chat-handlers";
import { isRecapText, RECAP_HINT, wrapRecapLine } from "../src/acp/recap";
import { RECAP_MIN_TURNS } from "../src/acp/recap";
import { NO_REPORTER } from "../src/herdr";
import pc from "../src/theme";
import { env } from "../src/utils";

const IDLE_MS = 1_500;

async function main(): Promise<void> {
  // `ROSSII_GOOSE_BIN` lets the probe run against a goose built from source,
  // instead of whichever `goose` happens to be on PATH.
  const client = AcpClient.spawn({ bin: env("GOOSE_BIN"), env: { RUST_LOG: "error" } });
  const ctx = createChatContext({
    cwd: process.cwd(),
    env: {},
    isNew: true,
    provider: env("GOOSE_PROVIDER") ?? "",
    model: env("GOOSE_MODEL") ?? "",
    useDefaultProfile: true,
    agentBuiltins: [],
    stdioExtensionSpecs: [],
    httpExtensionUris: [],
    recapEnabled: true,
    recapAuto: true,
    recapIdleMs: IDLE_MS,
  });

  // The screen, stubbed: a real transcript container, a TUI that never paints.
  ctx.client = client;
  ctx.tui = { requestRender() {}, setFocus() {}, hasOverlay: () => false } as any;
  ctx.transcript = new Container();
  ctx.editor = { getText: () => "", addToHistory() {}, setText() {} } as any;
  ctx.loader = { setMessage() {}, setText() {}, start() {}, stop() {} } as any;
  ctx.herdr = NO_REPORTER;
  setPromptHandlers(ctx);
  client.onUpdate((notification) => {
    const update = notification.update as any;
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      const text = String(update.content.text ?? "");
      if (text.trim() !== "") process.stdout.write(pc.dim(`  · chunk ${JSON.stringify(text.slice(0, 100))}\n`));
    }
    handleSessionUpdate(ctx, notification);
  });

  await client.initialize({ fs: { readTextFile: true, writeTextFile: true } });
  const session = await client.newSession({
    cwd: process.cwd(),
    mcpServers: [],
    _meta: newSessionMeta({ sessionTitle: "recap-auto-probe" }),
  });
  ctx.sessionId = session.sessionId;
  console.log(pc.dim(`session ${session.sessionId} · recap-auto-probe · idle ${IDLE_MS} ms`));

  // The one exchange, so the recap has something to describe. This is the turn
  // whose end arms the timer.
  await submitPrompt(ctx, "Reply with exactly: ACK");
  const blocksBefore = ctx.transcript.children.length;
  const armed = ctx.recapTimer !== null;
  console.log(`${armed ? pc.green("✓") : pc.red("✗")} the end of the turn armed the recap timer`);

  // The precondition the probe sets instead of paying for it (see the header).
  ctx.turnsStarted = RECAP_MIN_TURNS;
  console.log(pc.dim(`(turns set to ${RECAP_MIN_TURNS} — the minimum — and no recap since)`));

  const started = Date.now();
  while (ctx.recapLine === null && Date.now() - started < IDLE_MS + 20_000) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const elapsed = Date.now() - started;
  const line = ctx.recapLine;
  const ok = line !== null && isRecapText(line);
  console.log(
    ok
      ? `${pc.green("✓")} the timer fired and the recap line was set after ${(elapsed / 1000).toFixed(1)}s`
      : `${pc.red("✗")} no recap line after ${(elapsed / 1000).toFixed(1)}s`,
  );
  console.log(
    ctx.transcript.children.length === blocksBefore
      ? `${pc.green("✓")} nothing was added to the transcript: no ❯ /recap echo, no answer block`
      : `${pc.red("✗")} the transcript grew by ${ctx.transcript.children.length - blocksBefore} block(s)`,
  );
  console.log(
    ctx.lastRecapTurn === RECAP_MIN_TURNS
      ? `${pc.green("✓")} the recap was recorded as this turn's — no second one in a row`
      : `${pc.yellow("⚠")} lastRecapTurn is ${ctx.lastRecapTurn}, expected ${RECAP_MIN_TURNS}`,
  );
  console.log(
    ctx.busy === false ? `${pc.green("✓")} the recap turn ended (the chat is idle again)` : `${pc.red("✗")} still busy`,
  );

  if (line) {
    console.log(`\n${pc.dim("the line above the composer, at 100 columns:")}`);
    for (const row of wrapRecapLine(line, 100)) console.log(pc.dim(row));
    console.log(pc.dim(`\n(hint: ${RECAP_HINT})`));
  }

  await client.stop();
  process.exit(ok ? 0 : 1);
}

await main();
