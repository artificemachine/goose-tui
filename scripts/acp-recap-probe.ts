#!/usr/bin/env bun
/**
 * Live probe for `/recap` — the whole chain, no TUI.
 *
 * Spawns `goose acp`, creates a session, has one exchange with the real
 * provider, then sends goose's `/recap` and checks what comes back:
 *
 *   1. goose dispatches the command (a `※ recap` answer, not the model reading
 *      "/recap" as a prompt),
 *   2. the answer is one message and the turn **ends** (no second answer — the
 *      bug that `applied` vs `yielded_with` used to cause),
 *   3. the shipped client module recognises and renders it exactly as the recap
 *      line above the composer would (`isRecapText` / `buildRecapLine` /
 *      `wrapRecapLine` from `src/acp/recap.ts`).
 *
 * Costs two provider calls. Run it by hand:
 *
 *   bun scripts/acp-recap-probe.ts
 */

import { AcpClient } from "../src/acp/client";
import { env } from "../src/utils";
import { newSessionMeta } from "../src/acp/session-meta";
import { RECAP_HINT, buildRecapLine, isRecapText, wrapRecapLine } from "../src/acp/recap";
import pc from "../src/theme";

const TITLE = "recap-probe";

async function main(): Promise<void> {
  // `ROSSII_GOOSE_BIN` lets the probe run against a goose built from source,
  // instead of whichever `goose` happens to be on PATH.
  const client = AcpClient.spawn({ bin: env("GOOSE_BIN"), env: { RUST_LOG: "error" } });
  let collected = "";
  let recapMessages = 0;
  let userChunksAfterRecap = 0;
  let seenRecap = false;

  client.onUpdate((notification) => {
    const update = notification.update as any;
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      const text = String(update.content.text ?? "");
      collected += text;
      if (isRecapText(collected) && !seenRecap) {
        seenRecap = true;
        recapMessages += 1;
      }
    }
    // A live `/recap` must not come back as a user message of its own.
    if (seenRecap && update.sessionUpdate === "user_message_chunk") userChunksAfterRecap += 1;
  });

  client.setPromptHandlers({
    requestPermission: () => Promise.resolve({ outcome: { outcome: "cancelled" as const } }),
    readTextFile: (p) => Promise.resolve({ content: "" }),
    writeTextFile: () => Promise.resolve(),
  });

  await client.initialize({ fs: { readTextFile: true, writeTextFile: true } });
  const session = await client.newSession({
    cwd: process.cwd(),
    mcpServers: [],
    _meta: newSessionMeta({ sessionTitle: TITLE }),
  });
  console.log(pc.dim(`session ${session.sessionId} · ${TITLE}`));

  // One exchange, so the recap has something to recap.
  await client.prompt(session.sessionId, [{ type: "text", text: "Reply with exactly: ACK" }]);
  console.log(`${pc.green("✓")} turn 1 done`);

  // The command itself. goose parses `/recap` before the model sees the turn.
  // The buffer starts afresh: the chat routes each message on its own first
  // visible text, so the previous answer must not leak into the recognition.
  collected = "";
  const started = Date.now();
  const result = await client.prompt(session.sessionId, [{ type: "text", text: "/recap" }]);
  const elapsed = Date.now() - started;
  console.log(
    `${pc.green("✓")} /recap answered in ${(elapsed / 1000).toFixed(1)}s · stopReason ${result.stopReason}`,
  );

  const answer = collected.trim();
  const ok = isRecapText(answer);
  console.log(
    ok
      ? `${pc.green("✓")} the answer carries the recap marker (isRecapText)`
      : `${pc.red("✗")} the answer is not a recap: ${JSON.stringify(answer.slice(0, 120))}`,
  );
  console.log(
    result.stopReason === "end_turn"
      ? `${pc.green("✓")} the turn ended after the recap (yielded, not continued)`
      : `${pc.red("✗")} unexpected stopReason ${result.stopReason}`,
  );
  console.log(
    userChunksAfterRecap === 0
      ? `${pc.green("✓")} /recap came back as no user message of its own`
      : `${pc.yellow("⚠")} ${userChunksAfterRecap} user chunk(s) arrived after the recap`,
  );

  const line = buildRecapLine(answer);
  console.log(`\n${pc.dim("the line above the composer, at 100 columns:")}`);
  for (const row of wrapRecapLine(line, 100)) console.log(pc.dim(row));
  console.log(pc.dim(`\n(hint: ${RECAP_HINT})`));

  await client.stop();
  process.exit(ok && result.stopReason === "end_turn" ? 0 : 1);
}

await main();
