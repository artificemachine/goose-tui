/**
 * The recap line: recognition, one-line shape, wrapping, `/recap-config`.
 *
 * The surface itself is proven in `scripts/theme-surface-test.ts` (it renders),
 * and the routing in the chat is a consequence of `isRecapText` — which is why
 * the marker's edge cases are pinned here.
 */

import { describe, expect, test } from "bun:test";

import {
  RECAP_HINT,
  RECAP_MAX_ROWS,
  buildRecapLine,
  describeRecapState,
  classifyRecapHead,
  isRecapCommand,
  isRecapText,
  parseDelay,
  parseRecapConfigCommand,
  shouldAutoRecap,
  wrapRecapLine,
} from "../src/acp/recap";
import { closeMessage, handleSessionUpdate } from "../src/acp/chat-stream";

describe("recognising a recap", () => {
  test("a recap answer is one that opens with the marker", () => {
    expect(isRecapText("※ recap: Loaded the handoff. Next, continue.")).toBe(true);
    expect(isRecapText("※ recap Loaded the handoff.")).toBe(true);
  });

  test("a leading blank line does not hide the marker", () => {
    // goose sends a bare "\n\n" between a tool call and the text that follows.
    expect(isRecapText("\n\n※ recap: x")).toBe(true);
    expect(isRecapText("   \t※ recap: x")).toBe(true);
  });

  test("an answer that merely quotes a recap is an answer", () => {
    expect(isRecapText("Here is what happened:\n\n※ recap: x")).toBe(false);
    expect(isRecapText("The recap prefix is ※ recap.")).toBe(false);
    expect(isRecapText("")).toBe(false);
  });

  test("a head that is still ambiguous is undecided, not an answer", () => {
    // goose delivers the marker in pieces (`※`, ` recap`, `:`): the chat holds
    // the head instead of opening a block it would have to move.
    expect(classifyRecapHead("※")).toBe("undecided");
    expect(classifyRecapHead("※ r")).toBe("undecided");
    expect(classifyRecapHead("※ rec")).toBe("undecided");
    expect(classifyRecapHead("  \n※ reca")).toBe("undecided");
    expect(classifyRecapHead("")).toBe("undecided");
  });

  test("the complete marker is a recap, whatever follows it", () => {
    expect(classifyRecapHead("※ recap")).toBe("recap");
    expect(classifyRecapHead("※ recap: x")).toBe("recap");
    expect(isRecapText("※ recap: x")).toBe(true);
    // Strictly: a bare glyph is not yet a recap.
    expect(isRecapText("※")).toBe(false);
  });

  test("a `※` that opens something else is an answer", () => {
    expect(classifyRecapHead("※ A footnote, not a recap.")).toBe("answer");
    expect(classifyRecapHead("※A footnote")).toBe("answer");
    expect(classifyRecapHead("※ recapitulate this")).toBe("answer");
  });
});

describe("the one-line shape", () => {
  test("it is the marker, the body and the way out", () => {
    expect(buildRecapLine("※ recap: Loaded the handoff; one plan untracked. Next, continue.")).toBe(
      `※ recap: Loaded the handoff; one plan untracked. Next, continue. ${RECAP_HINT}`,
    );
  });

  test("a recap without the colon still gets one", () => {
    expect(buildRecapLine("※ recap Loaded the handoff.")).toBe(`※ recap: Loaded the handoff. ${RECAP_HINT}`);
  });

  test("newlines and runs of spaces collapse — the surface is rows of text", () => {
    expect(buildRecapLine("※ recap: one\n\ntwo    three")).toBe(`※ recap: one two three ${RECAP_HINT}`);
  });

  test("an existing hint is not doubled", () => {
    const once = buildRecapLine(`※ recap: x ${RECAP_HINT}`);
    expect(once).toBe(`※ recap: x ${RECAP_HINT}`);
    expect(buildRecapLine(once)).toBe(once);
  });

  test("an empty body keeps only the marker and the hint", () => {
    expect(buildRecapLine("※ recap:")).toBe(`※ recap: ${RECAP_HINT}`);
    expect(buildRecapLine("")).toBe(`※ recap: ${RECAP_HINT}`);
  });

  test("markdown is flattened: bold, code and bullets leave their syntax behind", () => {
    const line = buildRecapLine(
      "※ recap: - **Thème Monokai** : aligné, `tsc` propre. - **Board** : ouvert (`wAX:p2`).",
    );
    expect(line).toBe(
      `※ recap: · Thème Monokai : aligné, tsc propre. · Board : ouvert (wAX:p2). ${RECAP_HINT}`,
    );
    expect(line).not.toContain("**");
    expect(line).not.toContain("`");
  });

  test("a body that would run for a paragraph is cut at a word, with an ellipsis", () => {
    const line = buildRecapLine(`※ recap: ${"mot ".repeat(80)}`);
    expect(line.length).toBeLessThan(220);
    expect(line).toContain("…");
    expect(line.trimEnd().endsWith(RECAP_HINT)).toBe(true);
    expect(line).not.toContain("mo …");
  });
});

describe("wrapping", () => {
  test("rows never exceed the width, one column of padding included", () => {
    const line = buildRecapLine(
      "※ recap: Loaded project handoff; found one untracked evaluation plan and no ICM memories. Next, continue with the handoff's recommended autonomy-plan work.",
    );
    for (const width of [20, 40, 80, 120]) {
      for (const row of wrapRecapLine(line, width)) {
        expect([...row].length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("at most two rows, whatever the model answers", () => {
    const verbose = buildRecapLine(
      "※ recap: (rien n'a bougé depuis 11:22) - **Thème Monokai** : aligné sur les emplacements Retrowave, tests 42/42, `tsc` propre, rien de commité. - **Board herdr** : ouvert (`wAX:p2`). - **En attente** : (1) `Ctrl+E` qui ouvre vim ; (2) `AGENTS.md` ligne obsolète ; (3) le commit.",
    );
    for (const width of [40, 60, 80, 100, 120]) {
      const rows = wrapRecapLine(verbose, width);
      expect(rows.length).toBeLessThanOrEqual(RECAP_MAX_ROWS);
      expect(rows.every((row) => [...row].length <= width)).toBe(true);
      // The way out survives the cut: a truncated line still says how to turn it off.
      expect(rows.join(" ").replace(/\s+/g, " ")).toContain(RECAP_HINT);
    }
  });

  test("a cut line marks the cut, right before the way out", () => {
    const long = buildRecapLine(`※ recap: ${"alpha beta gamma delta ".repeat(8)}`);
    const rows = wrapRecapLine(long, 60);
    const flat = rows.join(" ").replace(/\s+/g, " ");
    expect(flat).toContain("…");
    expect(flat.endsWith(RECAP_HINT)).toBe(true);
    expect([...flat].length).toBeLessThan(long.length);
  });

  test("a short recap keeps every word, in order, with no ellipsis", () => {
    const line = buildRecapLine("※ recap: alpha beta gamma");
    const rows = wrapRecapLine(line, 120);
    expect(rows.join(" ").replace(/\s+/g, " ").trim()).toBe(line);
    expect(rows.length).toBeLessThanOrEqual(RECAP_MAX_ROWS);
  });

  test("a word longer than the row is broken rather than painted past the edge", () => {
    const rows = wrapRecapLine(`※ recap: ${"x".repeat(60)}`, 10);
    expect(rows.length).toBeLessThanOrEqual(RECAP_MAX_ROWS);
    expect(rows.every((row) => [...row].length <= 10)).toBe(true);
    expect(rows.join("")).toContain("xxxxxx");
    expect(rows[rows.length - 1].trimEnd().endsWith("…")).toBe(true);
  });

  test("a width too narrow for the way out still stops at two rows", () => {
    const line = buildRecapLine(`※ recap: ${"mot ".repeat(40)}`);
    const rows = wrapRecapLine(line, 14);
    expect(rows.length).toBeLessThanOrEqual(RECAP_MAX_ROWS);
    expect(rows.every((row) => [...row].length <= 14)).toBe(true);
  });
});

describe("/recap-config", () => {
  test("bare means show", () => {
    expect(parseRecapConfigCommand([])).toEqual({ kind: "show" });
    expect(parseRecapConfigCommand(["  "])).toEqual({ kind: "show" });
  });

  test("on and off are the surface", () => {
    expect(parseRecapConfigCommand(["on"])).toEqual({ kind: "set-enabled", enabled: true });
    expect(parseRecapConfigCommand(["OFF"])).toEqual({ kind: "set-enabled", enabled: false });
    expect(parseRecapConfigCommand(["toggle"])).toEqual({ kind: "toggle-enabled" });
  });

  test("auto on, auto off, auto alone, auto with a delay", () => {
    expect(parseRecapConfigCommand(["auto"])).toEqual({ kind: "toggle-auto" });
    expect(parseRecapConfigCommand(["auto", "on"])).toEqual({ kind: "set-auto", auto: true });
    expect(parseRecapConfigCommand(["auto", "off"])).toEqual({ kind: "set-auto", auto: false });
    expect(parseRecapConfigCommand(["auto", "30s"])).toEqual({ kind: "set-delay", ms: 30_000 });
    expect(parseRecapConfigCommand(["auto", "2m"])).toEqual({ kind: "set-delay", ms: 120_000 });
    expect(parseRecapConfigCommand(["auto", "45000"])).toEqual({ kind: "set-delay", ms: 45_000 });
    expect(parseRecapConfigCommand(["auto", "off"])).toEqual({ kind: "set-auto", auto: false });
  });

  test("a delay of 0 is the way to say never", () => {
    expect(parseDelay("off")).toEqual({ ms: 0 });
    expect(parseDelay("never")).toEqual({ ms: 0 });
    expect(parseDelay("90s")).toEqual({ ms: 90_000 });
    expect("error" in parseDelay("soon")).toBe(true);
  });

  test("anything else is refused by name, not guessed at", () => {
    const wrong = parseRecapConfigCommand(["maybe"]);
    expect(wrong.kind).toBe("error");
    if (wrong.kind === "error") expect(wrong.message).toContain("maybe");
    expect(parseRecapConfigCommand(["on", "off"]).kind).toBe("error");
    expect(parseRecapConfigCommand(["auto", "on", "off"]).kind).toBe("error");
  });

  test("the state reads as one sentence in both directions", () => {
    expect(describeRecapState(true)).toContain("on");
    expect(describeRecapState(false)).toContain("off");
  });

  test("the state names the automatic generation and its delay", () => {
    expect(describeRecapState(true, true, 30_000)).toContain("30s idle");
    expect(describeRecapState(true, false, 30_000)).toContain("Automatic: off");
    expect(describeRecapState(true, true, 0)).toContain("Automatic: off");
    expect(describeRecapState(false, true, 30_000)).not.toContain("Automatic");
  });
});

describe("the automatic trigger (pi-recap's auto: true)", () => {
  const idle = {
    enabled: true,
    auto: true,
    busy: false,
    permissionOpen: false,
    draft: "",
    turns: 5,
    lastRecapTurn: 4,
  };

  test("an idle session that has worked since the last recap earns one", () => {
    expect(shouldAutoRecap(idle)).toBe(true);
  });

  test("nothing new since the last recap means nothing to recap", () => {
    expect(shouldAutoRecap({ ...idle, lastRecapTurn: 5 })).toBe(false);
  });

  test("a session shorter than three turns is not worth one", () => {
    expect(shouldAutoRecap({ ...idle, turns: 2, lastRecapTurn: 0 })).toBe(false);
    expect(shouldAutoRecap({ ...idle, turns: 3, lastRecapTurn: 0 })).toBe(true);
  });

  test("a running turn, a permission prompt or a draft all hold it off", () => {
    expect(shouldAutoRecap({ ...idle, busy: true })).toBe(false);
    expect(shouldAutoRecap({ ...idle, permissionOpen: true })).toBe(false);
    expect(shouldAutoRecap({ ...idle, draft: "half a question" })).toBe(false);
    expect(shouldAutoRecap({ ...idle, draft: "   " })).toBe(true);
  });

  test("switching it off stops it: the surface and the automatic call are separate", () => {
    expect(shouldAutoRecap({ ...idle, auto: false })).toBe(false);
    expect(shouldAutoRecap({ ...idle, enabled: false })).toBe(false);
  });
});

describe("the /recap command itself", () => {
  test("it is recognised with or without the slash, in any case", () => {
    expect(isRecapCommand("/recap")).toBe(true);
    expect(isRecapCommand("  /RECAP  ")).toBe(true);
    expect(isRecapCommand("recap")).toBe(true);
  });

  test("a question that mentions it is a question", () => {
    expect(isRecapCommand("/recap please")).toBe(false);
    expect(isRecapCommand("/recap-config")).toBe(false);
    expect(isRecapCommand("/recap:clear")).toBe(false);
  });
});

describe("routing a recap answer", () => {
  // The chunk handler touches a dozen fields; the ones a recap answer reads are
  // the streaming refs. A cast keeps the fixture honest about its narrowness.
  function fixture(overrides: Record<string, unknown> = {}) {
    const ctx = {
      recapEnabled: true,
      recapLine: null as string | null,
      recapMessageId: null as string | null,
      recapText: "",
      currentMd: null,
      currentMessageId: null as string | null,
      streamBuffer: "",
      pendingAnswer: "",
      answerLabelLine: null,
      answerChars: 0,
      currentThought: null,
      userLine: null,
      userBuffer: "",
      userMessageId: null,
      lastAgentActivity: 0,
      transcript: {
        children: [] as unknown[],
        addChild(child: unknown) {
          this.children.push(child);
        },
        removeChild(child: unknown) {
          this.children = this.children.filter((existing) => existing !== child);
        },
      },
      tui: { requestRender() {} },
      ...overrides,
    };
    return ctx;
  }

  function chunk(text: string, messageId = "m1") {
    return {
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text },
      },
    } as any;
  }

  test("a recap answer lands on the line, not in the transcript", () => {
    const ctx = fixture();
    handleSessionUpdate(ctx as any, chunk("※ recap: Loaded the handoff."));
    expect(ctx.transcript.children).toHaveLength(0);
    expect(ctx.recapLine).toContain("Loaded the handoff.");
    expect(ctx.recapMessageId).toBe("m1");
  });

  test("the later chunks of the same message keep appending to the line", () => {
    const ctx = fixture();
    handleSessionUpdate(ctx as any, chunk("※ recap: Loaded"));
    handleSessionUpdate(ctx as any, chunk(" the handoff. Next, continue."));
    expect(ctx.transcript.children).toHaveLength(0);
    expect(ctx.recapLine).toContain("Loaded the handoff. Next, continue.");
    expect(ctx.recapLine?.match(/※ recap:/g)).toHaveLength(1);
  });

  test("a normal answer is untouched", () => {
    const ctx = fixture();
    handleSessionUpdate(ctx as any, chunk("The parser is fixed."));
    expect(ctx.transcript.children.length).toBeGreaterThan(0);
    expect(ctx.recapLine).toBeNull();
  });

  test("with recaps switched off the answer stays in the transcript", () => {
    const ctx = fixture({ recapEnabled: false });
    handleSessionUpdate(ctx as any, chunk("※ recap: Loaded the handoff."));
    expect(ctx.transcript.children.length).toBeGreaterThan(0);
    expect(ctx.recapLine).toBeNull();
  });

  test("the line survives the turn: only the streaming target is dropped", () => {
    const ctx = fixture();
    handleSessionUpdate(ctx as any, chunk("※ recap: Loaded the handoff."));
    closeMessage(ctx as any);
    expect(ctx.recapMessageId).toBeNull();
    expect(ctx.recapLine).toContain("Loaded the handoff.");
  });
});
