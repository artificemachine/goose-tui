/**
 * Leaving and interrupting the chat (`src/acp/chat-ui.ts`,
 * `src/acp/chat-config.ts`): the tests `docs/specs/SPEC-004-chat-keys.md`
 * binds to.
 *
 * Usage: bun test tests/
 */

import { expect, test } from "bun:test";

import { Container } from "@earendil-works/pi-tui";

import { handleCommand } from "../src/acp/chat-config";
import type { ChatContext } from "../src/acp/chat-context";
import { attachInputListener } from "../src/acp/chat-ui";

type Listener = (data: string) => { consume?: boolean } | undefined;

/** Esc and Ctrl+C, as the terminal sends them. */
const ESC = "\x1b";
const CTRL_C = "\x03";

interface Harness {
  ctx: ChatContext;
  cancelled: string[];
  stopped: { client: number; tui: number };
  press(data: string): { consume?: boolean } | undefined;
}

/** A context wide enough for the input listener and `/exit`, and nothing else. */
function makeHarness(overrides: Partial<ChatContext> = {}): Harness {
  const cancelled: string[] = [];
  const stopped = { client: 0, tui: 0 };
  let listener: Listener | undefined;
  // SAFETY: the harness supplies only the fields the code under test reads, and
  // each has the shape ChatContext declares for it.
  const ctx = {
    transcript: new Container(),
    tui: {
      addInputListener: (fn: Listener) => { listener = fn; },
      hasOverlay: () => false,
      requestRender: () => {},
      stop: () => { stopped.tui++; },
      setFocus: () => {},
    },
    editor: { capturesViewportInput: false, getText: () => "", setText: () => {} },
    client: {
      closed: false,
      cancel: (id: string) => { cancelled.push(id); },
      stop: async () => { stopped.client++; },
    },
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
  if (!listener) throw new Error("the input listener was not registered");
  const registered = listener;
  return { ctx, cancelled, stopped, press: (data) => registered(data) };
}

/** Replace `process.exit` while `run` executes; shutdown calls it. */
async function withExitSpy(run: (calls: number[]) => Promise<void>): Promise<void> {
  const calls: number[] = [];
  const realExit = process.exit;
  const realWrite = process.stdout.write;
  // SAFETY: the test only records the call; nothing is terminated.
  process.exit = ((code?: number) => { calls.push(code ?? 0); return undefined as never; }) as unknown as typeof process.exit;
  // SAFETY: shutdown drains stdout; the test must not print into the report.
  process.stdout.write = ((_chunk: unknown, cb?: unknown) => {
    if (typeof cb === "function") (cb as () => void)();
    return true;
  }) as unknown as typeof process.stdout.write;
  try {
    await run(calls);
  } finally {
    process.exit = realExit;
    process.stdout.write = realWrite;
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

test("esc_never_exits_the_chat", async () => {
  // While the agent is alive: idle, mid-turn, or waiting for a new title.
  for (const overrides of [{}, { busy: true }, { awaitingRename: true }]) {
    const h = makeHarness(overrides);
    await withExitSpy(async (calls) => {
      h.press(ESC);
      h.press(ESC);
      await settle();
      expect(calls).toEqual([]);
      expect(h.ctx.exiting).toBe(false);
      expect(h.stopped).toEqual({ client: 0, tui: 0 });
    });
  }
});

test("esc_cancels_the_running_turn", async () => {
  const running = makeHarness({ busy: true });
  running.press(ESC);
  expect(running.cancelled).toEqual(["s1"]);

  // Idle: nothing to cancel, and the way out is explained once.
  const idle = makeHarness();
  const before = idle.ctx.transcript.children.length;
  idle.press(ESC);
  idle.press(ESC);
  expect(idle.cancelled).toEqual([]);
  expect(idle.ctx.transcript.children.length).toBe(before + 1);
});

test("ctrl_c_exits_the_chat", async () => {
  const h = makeHarness();
  await withExitSpy(async (calls) => {
    h.press(CTRL_C);
    await settle();
    expect(calls).toEqual([0]);
    expect(h.ctx.exiting).toBe(true);
    expect(h.stopped).toEqual({ client: 1, tui: 1 });
  });
});

test("dead_agent_chat_closes_on_either_key", async () => {
  // Nothing is left to cancel once the agent has exited, so Esc closes too.
  for (const key of [ESC, CTRL_C]) {
    const h = makeHarness({ agentDead: true });
    await withExitSpy(async (calls) => {
      h.press(key);
      await settle();
      expect(calls).toEqual([0]);
      expect(h.cancelled).toEqual([]);
    });
  }
});

test("exit_command_closes_the_chat", async () => {
  for (const command of ["/exit", "/quit"]) {
    const h = makeHarness();
    await withExitSpy(async (calls) => {
      await handleCommand(h.ctx, command);
      await settle();
      expect(calls).toEqual([0]);
      expect(h.ctx.exiting).toBe(true);
      // The agent is stopped before the terminal is given back.
      expect(h.stopped).toEqual({ client: 1, tui: 1 });
    });
  }
});
