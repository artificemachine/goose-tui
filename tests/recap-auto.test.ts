/**
 * The automatic recap timer: armed at the end of a turn, cancelled by the next
 * one, and fired as a *quiet* `/recap` — no `❯ /recap` echo, no turn rule.
 *
 * The delay floor is one second (`armAutoRecap` clamps it), so the firing case
 * waits a real second rather than faking the clock: a test that avoided the wait
 * would not prove the timer is actually the thing that sent the prompt.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { armAutoRecap, cancelAutoRecap, submitQuietRecap } from "../src/acp/recap-auto";
import { finishTurn } from "../src/acp/chat-io";
import { handleSessionUpdate } from "../src/acp/chat-stream";

interface PromptCall {
  sessionId: string;
  text: string;
}

function fixture(overrides: Record<string, unknown> = {}) {
  const calls: PromptCall[] = [];
  const transcript: unknown[] = [];
  const ctx = {
    // Session
    sessionId: "session-1",
    busy: false,
    agentDead: false,
    // Recap settings
    recapEnabled: true,
    recapAuto: true,
    recapIdleMs: 1_000,
    recapTimer: null as ReturnType<typeof setTimeout> | null,
    recapLine: null as string | null,
    recapMessageId: null,
    recapText: "",
    lastRecapTurn: 0,
    turnsStarted: 5,
    quietPrompt: false,
    recapExpected: false,
    recapAsPrompt: false,
    // Turn state the submit path touches
    cancelRequested: false,
    activeRunId: null,
    lastAgentActivity: 0,
    currentMd: null,
    currentMessageId: null,
    streamBuffer: "",
    answerLabelLine: null,
    answerChars: 0,
    currentThought: null,
    userLine: null,
    userBuffer: "",
    userMessageId: null,
    currentMessageIdle: null,
    toolBlocks: [],
    toolCallBlocks: new Map(),
    steerEntries: [],
    steerAckIds: new Set<string>(),
    permissionQueue: [],
    activePermission: null,
    pendingPrompt: null,
    pendingSteers: [],
    turnsStartedReset: 0,
    turnTimeout: { ms: 5_000 },
    herdr: { enabled: false, report() {} },
    loader: { setText() {}, setMessage() {}, stop() {}, start() {} },
    editor: { getText: () => "", addToHistory() {} },
    transcript: {
      addChild(child: unknown) {
        transcript.push(child);
      },
      removeChild() {},
      clear() {},
    },
    tui: { requestRender() {} },
    client: {
      async prompt(sessionId: string, content: Array<{ text: string }>) {
        calls.push({ sessionId, text: content[0]?.text ?? "" });
        return { stopReason: "end_turn" };
      },
      stop: async () => undefined,
    },
    ...overrides,
  };
  return { ctx, calls, transcript };
}

const timers: Array<ReturnType<typeof setTimeout>> = [];
afterEach(() => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("arming and cancelling", () => {
  test("a turn end arms it, and nothing is sent before the delay", async () => {
    const { ctx, calls } = fixture();
    armAutoRecap(ctx as any);
    expect(ctx.recapTimer).not.toBeNull();
    await wait(120);
    expect(calls).toHaveLength(0);
    cancelAutoRecap(ctx as any);
    expect(ctx.recapTimer).toBeNull();
  });

  test("cancelling is what a new turn does: nothing fires", async () => {
    const { ctx, calls } = fixture();
    armAutoRecap(ctx as any);
    cancelAutoRecap(ctx as any);
    await wait(1_200);
    expect(calls).toHaveLength(0);
  });

  test("an errored turn or a dead agent arms nothing", () => {
    const dead = fixture({ agentDead: true });
    armAutoRecap(dead.ctx as any);
    expect(dead.ctx.recapTimer).toBeNull();

    const off = fixture({ recapEnabled: false });
    armAutoRecap(off.ctx as any);
    expect(off.ctx.recapTimer).toBeNull();

    const noAuto = fixture({ recapAuto: false });
    armAutoRecap(noAuto.ctx as any);
    expect(noAuto.ctx.recapTimer).toBeNull();

    const never = fixture({ recapIdleMs: 0 });
    armAutoRecap(never.ctx as any);
    expect(never.ctx.recapTimer).toBeNull();
  });
});

describe("firing", () => {
  test("an idle session sends a quiet /recap, with no echo and no turn rule", async () => {
    const { ctx, calls, transcript } = fixture();
    armAutoRecap(ctx as any);
    timers.push(ctx.recapTimer!);
    await wait(1_200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe("/recap");
    expect(calls[0]?.sessionId).toBe("session-1");
    // A recap is not something the user said: nothing is echoed, no `❯` line,
    // no dashed turn separator.
    expect(transcript).toHaveLength(0);
    expect(ctx.quietPrompt).toBe(false);
  });

  test("a draft in the composer holds it off — the user is mid-sentence", async () => {
    const { ctx, calls } = fixture({ editor: { getText: () => "half a question", addToHistory() {} } });
    armAutoRecap(ctx as any);
    timers.push(ctx.recapTimer!);
    await wait(1_200);
    expect(calls).toHaveLength(0);
  });

  test("a permission prompt or a running turn holds it off too", async () => {
    const permission = fixture({ activePermission: { finish: () => {} } });
    armAutoRecap(permission.ctx as any);
    timers.push(permission.ctx.recapTimer!);
    await wait(1_200);
    expect(permission.calls).toHaveLength(0);

    const running = fixture({ busy: true });
    armAutoRecap(running.ctx as any);
    timers.push(running.ctx.recapTimer!);
    await wait(1_200);
    expect(running.calls).toHaveLength(0);
  });

  test("a session too short to have anything to say is left alone", async () => {
    const { ctx, calls } = fixture({ turnsStarted: 2 });
    armAutoRecap(ctx as any);
    timers.push(ctx.recapTimer!);
    await wait(1_200);
    expect(calls).toHaveLength(0);
  });

  test("nothing new since the last recap → no second one in a row", async () => {
    const { ctx, calls } = fixture({ lastRecapTurn: 5 });
    armAutoRecap(ctx as any);
    timers.push(ctx.recapTimer!);
    await wait(1_200);
    expect(calls).toHaveLength(0);
  });
});

describe("the manual path", () => {
  test("`/recap` typed by the user takes the same quiet route", async () => {
    const { ctx, calls, transcript } = fixture();
    submitQuietRecap(ctx as any);
    // The prompt is dispatched from a dynamic import, so give it a tick.
    await wait(50);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe("/recap");
    expect(transcript).toHaveLength(0);
  });

  test("it refuses while a turn runs or before a session exists", async () => {
    const busy = fixture({ busy: true });
    submitQuietRecap(busy.ctx as any);
    await wait(50);
    expect(busy.calls).toHaveLength(0);

    const noSession = fixture({ sessionId: null });
    submitQuietRecap(noSession.ctx as any);
    await wait(50);
    expect(noSession.calls).toHaveLength(0);
  });
});

describe("when the command does not run", () => {
  // Seen live on 2026-11-23: two `/recap` prompts were answered by the model as
  // prose instead of being dispatched by goose. The line never appeared and the
  // turn ended in silence — nothing said the command had been skipped.
  test("a prose answer is reported at the end of the turn, not swallowed", async () => {
    const { ctx, transcript } = fixture();
    await submitQuietRecap(ctx as any);
    expect(ctx.recapExpected).toBe(true);
    // goose answered the prompt itself instead of running the command.
    handleSessionUpdate(ctx as any, {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "m-prose",
        content: { type: "text", text: "Here is a recap of the session: we did things." },
      },
    } as any);
    finishTurn(ctx as any);
    const lines = transcript.map((child: any) => String(child?.text ?? child)).join("\n");
    expect(lines).toContain("/recap came back as an ordinary message");
    expect(ctx.recapExpected).toBe(false);
  });

  test("a real recap clears the expectation, so the turn ends quiet", async () => {
    const { ctx, transcript } = fixture();
    await submitQuietRecap(ctx as any);
    handleSessionUpdate(ctx as any, {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "m-1",
        content: { type: "text", text: "※ recap: nothing moved. Next, restart." },
      },
    } as any);
    expect(ctx.recapExpected).toBe(false);
    finishTurn(ctx as any);
    const lines = transcript.map((child: any) => String(child?.text ?? child)).join("\n");
    expect(lines).not.toContain("came back as an ordinary message");
  });
});
