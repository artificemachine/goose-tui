#!/usr/bin/env bun
/**
 * Unit tests for the Esc / Ctrl+C input listener (`attachInputListener`).
 *
 * The bug this pins: with an empty composer and no turn running, Esc used to
 * close the whole chat. Esc is the "stop" key — it cancels the running turn —
 * while quitting is Ctrl+C alone.
 *
 * Usage: bun scripts/acp-esc-key-test.ts
 */

import assert from "node:assert/strict";

import { Container, Key } from "@earendil-works/pi-tui";

import { attachInputListener } from "../src/acp/chat-ui.ts";
import type { ChatContext } from "../src/acp/chat-context.ts";

type Listener = (data: string) => { consume?: boolean } | undefined;

interface Harness {
  ctx: ChatContext;
  transcript: Container;
  cancelled: string[];
  exitCalls: number[];
  press(data: string): { consume?: boolean } | undefined;
}

/** A context wide enough for the input listener, and nothing else. */
function makeHarness(overrides: Partial<ChatContext> = {}): Harness {
  const transcript = new Container();
  const cancelled: string[] = [];
  const exitCalls: number[] = [];
  let listener: Listener | undefined;
  // SAFETY: the harness supplies only the fields the input listener reads, and every
  // one of them has the shape ChatContext declares for it in this fixture.
  const ctx = {
    transcript,
    tui: {
      addInputListener: (fn: Listener) => { listener = fn; },
      hasOverlay: () => false,
      requestRender: () => {},
      stop: () => {},
      setFocus: () => {},
    },
    editor: { capturesViewportInput: false, getText: () => "" },
    client: { closed: false, cancel: (id: string) => { cancelled.push(id); }, stop: async () => {} },
    activePermission: null,
    agentDead: false,
    awaitingRename: false,
    busy: false,
    sessionId: "s1",
    exiting: false,
    steerEntries: [],
    exitHintShown: false,
    loader: { setMessage: () => {}, stop: () => {}, setText: () => {}, start: () => {} },
    permissionQueue: [],
    ...overrides,
  } as unknown as ChatContext;

  attachInputListener(ctx);
  assert.ok(listener, "the listener is registered");

  return {
    ctx,
    transcript,
    cancelled,
    exitCalls,
    press: (data: string) => listener!(data),
  };
}

const checks: Array<[string, () => void | Promise<void>]> = [];
const ok = (name: string, fn: () => void | Promise<void>) => checks.push([name, fn]);

/** Esc and Ctrl+C, as the terminal sends them. */
const ESC = "\x1b";
const CTRL_C = "\x03";

/** Replace `process.exit` for the duration of a check (shutdown calls it). */
async function withExitSpy(run: (calls: number[]) => void | Promise<void>): Promise<void> {
  const calls: number[] = [];
  const real = process.exit;
  const realWrite = process.stdout.write;
  // SAFETY: the test only records the call; nothing is written or terminated.
  process.exit = ((code?: number) => { calls.push(code ?? 0); return undefined as never; }) as unknown as typeof process.exit;
  // SAFETY: shutdown drains stdout; the test must not print into the report.
  process.stdout.write = ((_chunk: unknown, cb?: unknown) => {
    if (typeof cb === "function") (cb as () => void)();
    return true;
  }) as unknown as typeof process.stdout.write;
  try {
    await run(calls);
  } finally {
    process.exit = real;
    process.stdout.write = realWrite;
  }
}

ok("Esc with no turn running does not exit the chat", async () => {
  const h = makeHarness();
  await withExitSpy(async (calls) => {
    h.press(ESC);
    await Promise.resolve();
    assert.deepEqual(calls, [], "Esc must never quit");
    assert.equal(h.ctx.exiting, false, "the chat is still running");
    assert.deepEqual(h.cancelled, [], "nothing to cancel while idle");
  });
});

ok("Esc while a turn runs cancels that turn instead of exiting", async () => {
  const h = makeHarness({ busy: true });
  await withExitSpy(async (calls) => {
    h.press(ESC);
    await Promise.resolve();
    assert.deepEqual(calls, [], "a cancel is not an exit");
    assert.deepEqual(h.cancelled, ["s1"], "the running turn is cancelled");
    assert.equal(h.ctx.exiting, false);
  });
});

ok("the idle Esc hint is printed once", () => {
  const h = makeHarness();
  const before = h.transcript.children.length;
  h.press(ESC);
  h.press(ESC);
  assert.equal(h.transcript.children.length, before + 1, "one hint, not two");
  assert.equal(h.ctx.exitHintShown, true);
});

ok("Ctrl+C still exits", async () => {
  const h = makeHarness();
  await withExitSpy(async (calls) => {
    h.press(CTRL_C);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, [0], "Ctrl+C exits with status 0");
    assert.equal(h.ctx.exiting, true);
  });
});

ok("Esc leaves the autocomplete menu to the editor", () => {
  const h = makeHarness();
  // SAFETY: only the flag the listener reads is needed here.
  (h.ctx.editor as unknown as { capturesViewportInput: boolean }).capturesViewportInput = true;
  assert.equal(h.press(ESC), undefined, "the key is not consumed, the editor closes its menu");
});

ok("Key.escape is the identifier the listener matches", () => {
  assert.equal(Key.escape, "escape");
});

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
