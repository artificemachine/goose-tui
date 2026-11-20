#!/usr/bin/env bun
/**
 * Unit tests for the web surface (`src/web/`).
 *
 * No goose, no port, no browser: the engine is a fake that emits exactly the
 * events a real one would, so the mapping, the HTTP contract and the event
 * stream are all pinned in-process.
 *
 * Usage: bun scripts/web-server-test.ts
 */

import assert from "node:assert/strict";

import { toWebEvent, sseFrame, type WebEvent } from "../src/web/event";
import { createApp, PAGE_HTML, type WebEngineLike } from "../src/web/server";
import { runWeb, startWebServer } from "../src/web/main";
import type { SessionNotification } from "../src/acp/types";

type Check = [name: string, run: () => void | Promise<void>];
const checks: Check[] = [];
const ok = (name: string, run: () => void | Promise<void>) => checks.push([name, run]);

// SAFETY: SessionUpdate is a closed union that does not admit the malformed
// shapes these tests feed it; each case is asserted through toWebEvent, which
// only reads plain fields off the object.
const notify = (update: Record<string, unknown>): SessionNotification =>
  ({ sessionId: "s1", update } as unknown as SessionNotification);

// ─── Mapping ────────────────────────────────────────────────────────────────

ok("an agent message chunk becomes text", () => {
  const event = toWebEvent(notify({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hello" },
  }));
  assert.deepEqual(event, { type: "text", text: "hello" });
});

ok("a thought chunk becomes a thought", () => {
  assert.deepEqual(
    toWebEvent(notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } })),
    { type: "thought", text: "hm" },
  );
});

ok("a tool call becomes a tool event with its status", () => {
  assert.deepEqual(
    toWebEvent(notify({ sessionUpdate: "tool_call", toolCallId: "t1", title: "shell", status: "in_progress" })),
    { type: "tool", id: "t1", title: "shell", status: "in_progress" },
  );
});

ok("a tool update without a title keeps its id", () => {
  assert.deepEqual(
    toWebEvent(notify({ sessionUpdate: "tool_call_update", toolCallId: "t2" })),
    { type: "tool", id: "t2", title: "t2", status: "pending" },
  );
});

ok("updates the web surface ignores return null", () => {
  assert.equal(toWebEvent(notify({ sessionUpdate: "usage_update", used: 1, size: 2 })), null);
  assert.equal(toWebEvent(notify({ sessionUpdate: "available_commands_update" })), null);
  assert.equal(toWebEvent(notify({ sessionUpdate: "agent_message_chunk", content: { type: "image" } })), null);
  // SAFETY: the mapping must tolerate a malformed notification without throwing.
  assert.equal(toWebEvent({} as unknown as SessionNotification), null);
});

ok("an SSE frame is one data line and a blank line", () => {
  assert.equal(sseFrame({ type: "text", text: "a" }), 'data: {"type":"text","text":"a"}\n\n');
});

// ─── HTTP surface ───────────────────────────────────────────────────────────

ok("GET / serves the page", async () => {
  const app = createApp({ createEngine: () => fakeEngine() });
  const response = await app.fetch(new Request("http://x/"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await response.text(), PAGE_HTML);
});

ok("GET /health reports the engine state", async () => {
  const app = createApp({ createEngine: () => fakeEngine() });
  const response = await app.fetch(new Request("http://x/health"));
  assert.deepEqual(await response.json(), { ok: true, busy: false });
});

ok("POST /prompt refuses a body without text", async () => {
  const engine = fakeEngine();
  const app = createApp({ createEngine: () => engine });
  const response = await app.fetch(new Request("http://x/prompt", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "content-type": "application/json" },
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "text is required" });
  assert.deepEqual(engine.prompts, []);
});

ok("POST /prompt answers 202 and hands the text to the engine", async () => {
  const engine = fakeEngine();
  const app = createApp({ createEngine: () => engine });
  const response = await app.fetch(new Request("http://x/prompt", {
    method: "POST",
    body: JSON.stringify({ text: "hi" }),
    headers: { "content-type": "application/json" },
  }));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(engine.prompts, ["hi"]);
});

ok("POST /cancel asks the engine to cancel", async () => {
  const engine = fakeEngine();
  const app = createApp({ createEngine: () => engine });
  const response = await app.fetch(new Request("http://x/cancel", { method: "POST" }));
  assert.equal(response.status, 202);
  assert.equal(engine.cancels, 1);
});

ok("an unknown route is a 404", async () => {
  const app = createApp({ createEngine: () => fakeEngine() });
  const response = await app.fetch(new Request("http://x/nope"));
  assert.equal(response.status, 404);
});

ok("GET /events streams what the engine emits", async () => {
  const sink: { emit?: (event: WebEvent) => void } = {};
  const engine = fakeEngine();
  const app = createApp({
    createEngine: (emit) => {
      sink.emit = emit;
      return engine;
    },
  });
  const response = await app.fetch(new Request("http://x/events"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(app.streams(), 1);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.equal(first, ": connected\n\n");

  assert.ok(sink.emit, "the engine received the sink");
  sink.emit({ type: "text", text: "chunk" });
  // The first frame is already buffered in the stream; the second read yields it.
  let buffered = "";
  for (let attempt = 0; attempt < 3 && !buffered.includes("chunk"); attempt++) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value);
  }
  assert.ok(buffered.includes('data: {"type":"text","text":"chunk"}'), buffered);

  app.dispose();
  assert.equal(app.streams(), 0);
});

ok("the page has a prompt box and an event source", () => {
  assert.ok(PAGE_HTML.includes('new EventSource("/events")'));
  assert.ok(PAGE_HTML.includes('fetch("/prompt"'));
});

// ─── Entry point ────────────────────────────────────────────────────────────

ok("startWebServer binds a real port and serves the page", async () => {
  const server = startWebServer({ port: 0, cwd: process.cwd() });
  try {
    assert.ok(server.port > 0, `bound port ${server.port}`);
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, busy: false });
  } finally {
    server.stop();
  }
});

ok("startWebServer refuses an impossible port", () => {
  assert.throws(() => startWebServer({ port: 70000 }), /invalid port 70000/);
  assert.throws(() => startWebServer({ port: -1 }), /invalid port -1/);
});

ok("runWeb refuses a flag with no value", async () => {
  await assert.rejects(() => runWeb(["--port"]), /--port needs a value/);
  await assert.rejects(() => runWeb(["--host", "--port", "1"]), /--host needs a value/);
});

// ─── Runner ─────────────────────────────────────────────────────────────────

interface Fake extends WebEngineLike {
  prompts: string[];
  cancels: number;
}

function fakeEngine(): Fake {
  const fake: Fake = {
    prompts: [],
    cancels: 0,
    isBusy: false,
    async start() {
      return "s1";
    },
    async prompt(text: string) {
      fake.prompts.push(text);
    },
    cancel() {
      fake.cancels++;
    },
  };
  return fake;
}

let failed = 0;
for (const [name, run] of checks) {
  try {
    await run();
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.error(`❌ ${name}`);
    console.error(error);
  }
}
if (failed > 0) {
  console.error(`\n❌ ${failed} of ${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\n✅ ${checks.length} checks passed`);
