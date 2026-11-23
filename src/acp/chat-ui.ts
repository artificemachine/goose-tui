/**
 * chat-ui.ts — UI assembly and process lifetime.
 *
 * Functions: setupUi (loader, editor, layout), startChat (start + hints),
 * attachInputListener (Ctrl+P/O/E, Esc-arming, Ctrl+C), startIdleWatchdog /
 * stopIdleWatchdog, attachAgentExit, shutdown.
 */

import pc, { STATUS_CHIPS, bandBackground, bandForeground, getTheme, stylePrompt, themeChrome } from "../theme";
import { TURN_STATE } from "../herdr";
import { journalError } from "../journal";
import {
  Container,
  Editor,
  HStack,
  Key,
  Loader,
  ProcessTerminal,
  ScrollView,
  Spacer,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  isViewportTUI,
  matchesKey,
  visibleWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { editorTheme } from "./chat-context";
import { buildCommandItems, createCommandCompleter } from "./command-complete";
import { suggestSuffix } from "./autosuggest";
import { loadInputHistory } from "./input-history";
import { wrapRecapLine } from "./recap";
import { getProjectHistoryPath } from "../project";
import { closeThought, closeToolBlocks, renderHeader, renderStatus } from "./chat-stream";
import { showConfigMenu, showModelMenu } from "./chat-config";
import { currentTimeouts, timeoutWarnings } from "./timeout-state";
import { planIdleAction } from "./timeouts";
import { abandonPendingSteers, setLoader } from "./chat-io";
import { cancelAutoRecap } from "./recap-auto";
import { cancelAllPermissions } from "./chat-handlers";
import type { ChatContext, StatusSegment } from "./chat-context";

// ─── UI assembly ─────────────────────────────────────────────────────────────

/** The marker pi-tui closes its fake cursor with (see `render()` in editor.js). */
const CURSOR_END = "\u001b_pi:/fc\u0007";

/** Keep the grey suggestion inside the line: drop what does not fit. */
function fitSuffix(text: string, room: number): string {
  if (room <= 0) return "";
  let fitted = "";
  for (const char of text) {
    if (visibleWidth(fitted + char) > room) break;
    fitted += char;
  }
  return fitted;
}

/**
 * The composer.
 *
 * Beyond the retrowave frame it is also the one place that paints the inline
 * autosuggestion: the grey remainder of the newest matching history entry, after
 * the cursor, exactly as fish and zsh-autosuggestions show it. The decision
 * itself is pure (`suggestSuffix` in ./autosuggest.ts) — here it only becomes
 * pixels, because only `render(width)` knows the real column count.
 *
 * The source is a getter, not a copy: the chat appends to the history while it
 * runs (`recordInput` in ./chat-io.ts), and a snapshot taken at startup would
 * stop suggesting the prompt just sent.
 */
export class PromptEditor extends Editor {
  private historySource: () => readonly string[] = () => [];

  /** Point the suggestion at the project's history (`chat-ui.ts` wires it). */
  setSuggestionSource(source: () => readonly string[]): void {
    this.historySource = source;
  }

  /**
   * No box around the composer: two full-width rules, nothing else.
   *
   * pi-tui's own `renderTopBorder` / `renderBottomBorder` already draw exactly
   * that (`"─".repeat(width)`, in `borderColor`, which is `pc.cyan` here), and
   * the content lines come out padded to the full width — so rossii only has to
   * stop adding what it used to: the `╭ ╮ ╰ ╯` corners and the `│` side bars.
   * The retrowave prompt surface (`stylePrompt`: `#E0DEF4` on `#16161E`) still
   * applies to every line, rules included.
   */
  override render(width: number): string[] {
    return this.withSuggestion(super.render(width), width).map(stylePrompt);
  }

  /** True when the cursor sits at the very end of the draft. */
  private cursorAtEnd(): boolean {
    const { line, col } = this.getCursor();
    const lines = this.getLines();
    const last = lines[lines.length - 1] ?? "";
    return line === lines.length - 1 && col >= last.length;
  }

  /**
   * Append the grey suffix to the line that holds the cursor (the last content
   * line, since a suggestion only exists when the cursor is at the end).
   *
   * The free room is measured on the *draft*, never on the rendered line: the
   * editor pads every content line to the full width, so `visibleWidth(lines[…])`
   * is always `width` and would leave no room at all. One column is reserved
   * for the fake cursor the editor already drew at the end.
   */
  /**
   * Take the grey suggestion (Right / End). False when there is nothing to
   * take, so the key keeps its normal meaning — Right at the end of a line
   * already does nothing, which is precisely why it can be the accept key.
   */
  acceptSuggestion(): boolean {
    const suffix = this.currentSuffix();
    if (suffix === null) return false;
    this.setText(this.getText() + suffix);
    this.tui.requestRender();
    return true;
  }

  /** The suffix that would be painted right now, or null. */
  private currentSuffix(): string | null {
    return suggestSuffix(this.getText(), this.historySource(), {
      cursorAtEnd: this.cursorAtEnd(),
      menuOpen: this.capturesViewportInput,
    });
  }

  private withSuggestion(lines: string[], width: number): string[] {
    const suffix = this.currentSuffix();
    if (suffix === null) return lines;
    const index = lines.length - 2;
    if (index < 0) return lines;
    const { line, col } = this.getCursor();
    const typed = (this.getLines()[line] ?? "").slice(0, col);
    const room = width - this.getPaddingX() * 2 - visibleWidth(typed) - 1;
    const fitted = fitSuffix(suffix, room);
    if (fitted === "") return lines;
    // The suffix goes right after the cursor block, not at the end of the padded
    // line: the editor pads every content line to the full width, so appending
    // would put the suggestion against the right edge. `CURSOR_END` is the marker
    // pi-tui closes the fake cursor with; whatever follows it is the right
    // padding, and the suggestion takes that many columns back.
    const rendered = lines[index]!;
    const anchor = rendered.lastIndexOf(CURSOR_END);
    if (anchor < 0) return lines;
    const cut = anchor + CURSOR_END.length;
    const tail = rendered.slice(cut);
    const ghostWidth = visibleWidth(fitted);
    if (tail.length < ghostWidth) return lines;
    const painted = [...lines];
    painted[index] = rendered.slice(0, cut) + pc.dim(fitted) + tail.slice(ghostWidth);
    return painted;
  }

}

/**
 * The status bar: a powerline strip of slanted chips, the same way `pi-bar`
 * draws pi's footer — no background of its own (the two separator glyphs are
 * painted as *foreground* and each chip body is closed with a full reset, so
 * the terminal shows through the bar and between the chips), only the text
 * colour coming from the theme: the chips are the neutral greys of
 * `STATUS_CHIPS`, the same in every theme.
 *
 * `\ue0ba` (thin right arrow) draws the chip's left slash, `\ue0bc` (thin left
 * arrow) its right one; both need a Nerd Font, and a terminal without one
 * renders two box glyphs rather than a slant.
 */
const CHIP_LEADING = "\ue0ba";
const CHIP_TRAILING = "\ue0bc";

/** One chip: slash, body, slash — each part closing with a full reset. */
export function chipSegment(chip: string, foreground: string, label: string): string {
  return (
    bandForeground(chip) + CHIP_LEADING + "\x1b[0m" +
    bandBackground(chip) + foreground + ` ${label} ` + "\x1b[0m" +
    bandForeground(chip) + CHIP_TRAILING + "\x1b[0m"
  );
}

export class StatusSurface implements Component {
  constructor(private readonly segments: () => readonly StatusSegment[]) {}
  invalidate(): void {}
  render(width: number): string[] {
    const labels = this.segments().map((segment) => segment.label.trim()).filter((label) => label !== "");
    if (labels.length === 0) return [""];
    const chrome = themeChrome();
    if (!chrome || !pc.isColorSupported) return [pc.dim(labels.join("  "))];
    const chips = STATUS_CHIPS;
    const text = bandForeground(chrome.statusFg);
    const out: string[] = [];
    let used = 0;
    for (const [index, label] of labels.entries()) {
      // Two separator glyphs, two spaces of padding: four columns around the text.
      const room = width - used - 4;
      if (room < 1) break;
      const shown = [...label].slice(0, room).join("");
      out.push(chipSegment(chips[index % chips.length]!, text, shown));
      used += shown.length + 4;
    }
    return [out.join("")];
  }
}

/**
 * The recap line: `※ recap: … (disable recaps in /recap-config)`, one muted row
 * directly above the composer — `pi-recap`'s widget placement, `aboveEditor`.
 *
 * It answers "where did we get to?" while the conversation keeps scrolling, so
 * it does not live in the transcript: goose's `/recap` answer is routed here by
 * `handleSessionUpdate` (`./recap.ts` decides what a recap looks like) and stays
 * until the next one replaces it. Null is an empty row, so the composer never
 * jumps when the first recap arrives.
 *
 * The text wraps on spaces (pi's widget does too): a recap is long — it names
 * what happened *and* what to do next — and truncating it would hide the half
 * that matters. The composer's block keeps its height by re-rendering, and a
 * null line is one empty row, so nothing jumps when the first recap arrives.
 */
export class RecapSurface implements Component {
  constructor(private readonly line: () => string | null) {}
  invalidate(): void {}
  render(width: number): string[] {
    const line = this.line();
    if (!line) return [""];
    return wrapRecapLine(line, width).map((row) => pc.dim(row));
  }
}

/**
 * The conversation surface: the transcript, scrolled to the end.
 *
 * There is no frame around it. The section bands close each block, the composer
 * draws its own rules and the status strip closes the screen, so a rounded box
 * only bought two columns of width and two rows of height on every themed
 * surface — and the bands read as a frame anyway.
 */
export function conversationView(document: Container): ScrollView {
  return new ScrollView(document, { follow: "end", primary: true, overscroll: "chain" });
}

// ─── Agent exit & shutdown ───────────────────────────────────────────────────

/** The agent may die at any moment: stop accepting prompts and say why. */
export function setupUi(ctx: ChatContext): void {
  const terminal = new ProcessTerminal();
  const tui: TUI = ctx.altScreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  ctx.tui = tui;

  // A plain Container, not a VStack: the transcript is not part of the layout
  // tree (the scroll view hosts a plain document), and `Stack.render` does not
  // record the child geometry `Container.handleMouse` hit-tests with — a VStack
  // here made every mouse event re-render the whole transcript.
  ctx.transcript = new Container();
  ctx.statusSegments = [];
  ctx.headerLine = new Text("", 1, 0);

  // In the inline renderer every repaint writes at the cursor (the last line)
  // and drags the terminal back to the bottom, so there the spinner must not
  // request renders: its ticks only advance the frame text and the next real
  // update paints it. With a viewport of our own the animation is harmless.
  const inertUi = { requestRender: () => {} } as unknown as TUI;
  const loader = new Loader(ctx.altScreen ? tui : inertUi, (s) => pc.cyan(s), (s) => pc.dim(s), "thinking…");
  // The constructor starts the animation; keep it idle until a turn runs.
  loader.stop();
  loader.setText("");
  ctx.loader = loader;

  // 8 rows of completion: the chat's twelve names plus goose's (builtins,
  // recipes, skills) is around two dozen, and the editor scrolls the rest with
  // its "(1/24)" counter.
  ctx.editor = new PromptEditor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
  // The `/…` menu. The list is read lazily — goose announces its own commands
  // after `session/new`, which is later than this line (./command-complete.ts).
  ctx.editor.setAutocompleteProvider(
    createCommandCompleter(() => buildCommandItems(ctx.gooseCommands)),
  );
  // The shell-like history and the grey suggestion (./input-history.ts,
  // ./autosuggest.ts): pi-tui browses ↑/↓ itself, but its list is per-instance
  // and empty, so the project's file is replayed into it here. Recording happens
  // in `recordInput` (./chat-io.ts) on every submit.
  ctx.inputHistory = loadInputHistory(getProjectHistoryPath());
  for (const entry of ctx.inputHistory.all()) ctx.editor.addToHistory(entry);
  if (ctx.editor instanceof PromptEditor) {
    ctx.editor.setSuggestionSource(() => ctx.inputHistory.all());
  }

  if (isViewportTUI(tui)) {
    // The header scrolls with the conversation (it is just the first lines of
    // the document), the composer stays pinned at the bottom. `follow: "end"`
    // auto-follows new content until the user scrolls up, and resumes when the
    // view is back at the bottom.
    const document = new Container();
    document.addChild(ctx.headerLine);
    document.addChild(new Spacer());
    document.addChild(ctx.transcript);

    const composer = new VStack([
      loader,
      new Spacer(),
      new RecapSurface(() => ctx.recapLine),
      ctx.editor,
      new StatusSurface(() => ctx.statusSegments),
    ]);
    tui.setLayoutRoot(new VStack([
      {
        component: conversationView(document),
        basis: 0,
        grow: 1,
        minSize: 1,
      },
      { component: composer, basis: "auto", shrink: 1, minSize: 2 },
    ]));
  } else {
    tui.addChild(ctx.headerLine);
    tui.addChild(new Spacer());
    tui.addChild(ctx.transcript);
    tui.addChild(loader);
    tui.addChild(new Spacer());
    tui.addChild(new RecapSurface(() => ctx.recapLine));
    tui.addChild(ctx.editor);
    tui.addChild(new StatusSurface(() => ctx.statusSegments));
  }
}

/** Take the terminal, paint the header, and print the startup hints. */
export function startChat(ctx: ChatContext): void {
  ctx.tui.start();
  ctx.tui.setFocus(ctx.editor);
  renderHeader(ctx);
  renderStatus(ctx);
  const settingWarnings = [
    ...timeoutWarnings(currentTimeouts(ctx)),
    ...(ctx.blockModeInvalid ? [ctx.blockModeInvalid] : []),
  ];
  for (const warning of [...settingWarnings, ...(ctx.steeringWarning ? [ctx.steeringWarning] : [])]) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ ${warning}`), 1, 0));
  }
  ctx.transcript.addChild(new Text(
    pc.dim(
      "Type / for the command list (Tab completes it, /help prints it) · /config changes provider, model, set or session · Ctrl+P config · Ctrl+O model · /edit $EDITOR" +
        " · Enter sends; Ctrl+J adds a line (Shift+Enter where the terminal reports it, \\ then Enter anywhere)" +
        (ctx.steeringEnabled ? " · Enter during a turn adds to that turn, Esc cancels it" : ""),
    ),
    1, 0,
  ));
  ctx.tui.requestRender();
}

// ─── Keyboard ────────────────────────────────────────────────────────────────

/** Every key the chat owns: quick menus, Ctrl+C, and the armed Esc exit. */
export function attachInputListener(ctx: ChatContext): void {
  ctx.tui.addInputListener((data: string): { consume?: boolean } | undefined => {
    // A permission prompt owns the keyboard entirely: Esc/Ctrl+C reject the tool
    // call. Without this, Esc exited the whole chat while the prompt was open.
    if (ctx.activePermission) return undefined;
    if (ctx.tui.hasOverlay()) {
      // A menu owns Esc (it closes the menu), but Ctrl+C stays the unconditional
      // "get me out" key, as it is everywhere else in the chat.
      if (matchesKey(data, Key.ctrl("c"))) {
        void shutdown(ctx);
        return { consume: true };
      }
      return undefined;
    }
    // Right / End take the grey suggestion when there is one (`/…` menu open
    // means the editor owns those keys, see `capturesViewportInput`).
    if (matchesKey(data, Key.right) || matchesKey(data, Key.end)) {
      if (ctx.editor instanceof PromptEditor && ctx.editor.acceptSuggestion()) {
        return { consume: true };
      }
    }
    // Quick keys. Ctrl+M cannot be used for the model menu: a terminal sends
    // Enter as CR, which *is* Ctrl+M, so the binding would fire on every
    // submitted prompt — Ctrl+O is the free equivalent.
    if (matchesKey(data, Key.ctrl("p"))) {
      showConfigMenu(ctx);
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      showModelMenu(ctx);
      return { consume: true };
    }
    const escape = matchesKey(data, Key.escape);
    const ctrlC = matchesKey(data, Key.ctrl("c"));
    if (!escape && !ctrlC) return undefined;

    if (ctx.agentDead || ctx.client.closed) {
      void shutdown(ctx);
      return { consume: true };
    }
    // Esc aborts the pending title prompt instead of exiting the chat.
    if (ctx.awaitingRename) {
      ctx.awaitingRename = false;
      ctx.editor.setText("");
      ctx.transcript.addChild(new Text(pc.dim("Rename cancelled."), 1, 0));
      ctx.tui.requestRender();
      return { consume: true };
    }
    if (ctx.busy && ctx.sessionId) {
      // Esc still cancels the whole turn — and goose throws away the steers it
      // has not picked up yet, so say it before it happens.
      if (ctx.steerEntries.length > 0) {
        ctx.transcript.addChild(new Text(
          pc.dim("Esc cancels the turn — a steer that is still queued will be discarded."),
          1, 0,
        ));
      }
      ctx.client.cancel(ctx.sessionId);
      setLoader(ctx, "cancelling…");
      return { consume: true };
    }
    if (ctrlC) {
      // Ctrl+C is the "just get me out" key: it always exits.
      void shutdown(ctx);
      return { consume: true };
    }
    // Esc with the autocomplete menu open belongs to the editor (it closes the
    // menu) — the draft must survive that.
    if (ctx.editor.capturesViewportInput) return undefined;
    // Esc is "stop", never "quit": it cancelled the turn above, and with no
    // turn running it does nothing. Quitting is Ctrl+C alone, because losing the
    // whole chat to a key meant for cancelling is the worst outcome of the two.
    if (!ctx.exitHintShown) {
      ctx.exitHintShown = true;
      ctx.transcript.addChild(new Text(
        pc.dim("Esc cancels a running turn · Ctrl+C exits"),
        1, 0,
      ));
      ctx.tui.requestRender();
    }
    return { consume: true };
  });
}

// ─── Watchdogs ───────────────────────────────────────────────────────────────

/**
 * Check once a second and decide from the *current* thresholds, so `/timeout`
 * takes effect on the next tick: the timer never has to be re-armed, and a
 * lowered threshold cannot be missed by a tick sized for the old one. The tick
 * returns on `busy` before doing anything else, so an idle chat costs one
 * comparison per second.
 */
const WATCHDOG_TICK_MS = 1_000;

/**
 * The tool call that has not finished yet, if any.
 *
 * `isFinished` — not the status — is the test: goose sends the initial
 * `tool_call` with status `pending` and only adds `in_progress` when something
 * live happens, so a `sleep 600` stays `pending` for ten minutes while the
 * agent is perfectly busy.
 */
function runningToolName(ctx: ChatContext): string | null {
  for (const block of ctx.toolCallBlocks.values()) {
    if (!block.isFinished) return block.title || "tool";
  }
  return null;
}

export function stopIdleWatchdog(ctx: ChatContext): void {
  if (!ctx.idleTimer) return;
  clearInterval(ctx.idleTimer);
  ctx.idleTimer = null;
}

/**
 * Idle watchdog: a long but *live* turn must not be interrupted, and a silent
 * one must not leave the UI stuck with `busy` forever (the request itself has
 * no deadline until the hard cap in ./timeouts.ts).
 *
 * Three states are not "the agent went silent": the user owes an answer
 * (a permission prompt or a menu is on screen), a tool call is still running
 * (its own, much larger, threshold applies — `ROSSII_ACP_TOOL_TIMEOUT_MS`), and
 * the turn is already over. The decision itself is pure — `planIdleAction()`
 * in ./timeouts.ts.
 */
export function startIdleWatchdog(ctx: ChatContext): void {
  stopIdleWatchdog(ctx);
  const idleTimer = setInterval(() => {
    const decision = planIdleAction({
      now: Date.now(),
      lastActivity: ctx.lastAgentActivity,
      busy: ctx.busy,
      hasSession: ctx.sessionId !== null,
      exiting: ctx.exiting,
      agentDead: ctx.agentDead,
      cancelRequested: ctx.cancelRequested,
      awaitingUser: ctx.activePermission !== null || ctx.permissionQueue.length > 0 || ctx.menuActive,
      runningTool: runningToolName(ctx),
      idleMs: ctx.idleTimeout.ms,
      toolMs: ctx.toolTimeout.ms,
    });
    if (decision.kind === "wait" || !ctx.sessionId) return;
    ctx.cancelRequested = true;
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ ${decision.reason}`), 1, 0));
    setLoader(ctx, "cancelling…");
    ctx.client.cancel(ctx.sessionId);
    ctx.tui.requestRender();
  }, WATCHDOG_TICK_MS);
  // Never keep the process alive by itself: the chat owns the lifetime.
  (idleTimer as unknown as { unref?: () => void }).unref?.();
  ctx.idleTimer = idleTimer;
}

// ─── Agent exit & shutdown ───────────────────────────────────────────────────

/** The agent may die at any moment: stop accepting prompts and say why. */
export function attachAgentExit(ctx: ChatContext): void {
  ctx.onAgentExit = () => {
    if (ctx.exiting || ctx.agentDead) return;
    ctx.agentDead = true;
    ctx.busy = false;
    ctx.herdr.report(TURN_STATE.end);
    ctx.activeRunId = null;
    setLoader(ctx, null);
    cancelAllPermissions(ctx);
    closeThought(ctx);
    closeToolBlocks(ctx);
    abandonPendingSteers(ctx, "goose exited before the steer was delivered");
    journalError("chat.agent", `goose acp exited unexpectedly: ${ctx.stderrTail.slice(-5).join(" | ")}`);
    ctx.transcript.addChild(new Text(pc.red("⚠ goose acp exited unexpectedly"), 1, 0));
    for (const line of ctx.stderrTail.slice(-5)) {
      ctx.transcript.addChild(new Text(pc.dim(line), 1, 0));
    }
    ctx.transcript.addChild(new Text(pc.dim("Press Esc to exit."), 1, 0));
    ctx.tui.requestRender();
  };
}

/** Stop the agent, hand the terminal back, exit the process. */
export async function shutdown(ctx: ChatContext): Promise<void> {
  if (ctx.exiting) return;
  ctx.exiting = true;
  ctx.herdr.report(TURN_STATE.shutdown);
  // A pending automatic recap would fire into a chat that is closing.
  cancelAutoRecap(ctx);
  // Do not leave the agent waiting for a permission answer.
  cancelAllPermissions(ctx);
  setLoader(ctx, null);
  try {
    await ctx.client.stop();
  } finally {
    ctx.tui.stop();
    // On the alternate screen tui.stop() prints the final transcript back to
    // the normal screen; give stdout a moment to drain before exiting so the
    // tail of it is not truncated.
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      try { process.stdout.write("", done); } catch { done(); }
      const timer = setTimeout(done, 500);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    process.exit(0);
  }
}
