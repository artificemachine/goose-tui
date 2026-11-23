/**
 * `submitPrompt` when a turn is already running.
 *
 * goose refuses a second `session/prompt` while a run is live, so rossii has to
 * decide what happens to what the user typed. It used to be dropped without a
 * word — a `/compact` sent mid-turn simply vanished. Anything the user wrote is
 * queued now; a *quiet* recap (the idle timer) is still dropped, because the
 * next turn end arms another one and queueing it would replay a recap the user
 * never asked for.
 */

import { describe, expect, test } from "bun:test";

import { submitPrompt } from "../src/acp/chat-io";

function fixture(overrides: Record<string, unknown> = {}) {
  const transcript: string[] = [];
  const calls: string[] = [];
  const ctx = {
    sessionId: "session-1",
    busy: true,
    quietPrompt: false,
    pendingPrompt: null as string | null,
    recapExpected: false,
    recapAsPrompt: false,
    recapTimer: null as ReturnType<typeof setTimeout> | null,
    agentDead: false,
    transcript: {
      addChild(child: unknown) {
        transcript.push(String((child as { text?: unknown })?.text ?? child));
      },
      removeChild() {},
      clear() {},
    },
    tui: { requestRender() {}, setFocus() {} },
    editor: { getText: () => "", setText() {}, addToHistory() {} },
    client: {
      async prompt(_id: string, content: Array<{ text: string }>) {
        calls.push(content[0]?.text ?? "");
        return { stopReason: "end_turn" };
      },
    },
    ...overrides,
  };
  return { ctx, transcript, calls };
}

describe("a prompt sent while a turn runs", () => {
  test("it is queued, with a line saying so", async () => {
    const { ctx, transcript, calls } = fixture();
    await submitPrompt(ctx as any, "/compact");
    expect(calls).toHaveLength(0);
    expect(ctx.pendingPrompt).toBe("/compact");
    expect(transcript.join("\n")).toContain("queued for after this turn");
  });

  test("a quiet recap is dropped instead: the next turn end arms another", async () => {
    const { ctx, transcript, calls } = fixture({ quietPrompt: true });
    await submitPrompt(ctx as any, "/recap");
    expect(calls).toHaveLength(0);
    expect(ctx.pendingPrompt).toBeNull();
    expect(transcript).toHaveLength(0);
    expect(ctx.quietPrompt).toBe(false);
  });

  test("with no session there is nothing to queue against", async () => {
    const { ctx, transcript } = fixture({ sessionId: null });
    await submitPrompt(ctx as any, "hello");
    expect(ctx.pendingPrompt ?? null).toBeNull();
    expect(transcript).toHaveLength(0);
  });
});
