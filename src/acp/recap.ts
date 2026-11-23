/**
 * The recap line — goose's `/recap` rendered the way `pi-recap` draws it.
 *
 * goose answers `/recap` with an ordinary assistant message that begins with
 * `※ recap:` (`ops_recap.rs`). In the transcript that reads as one more answer,
 * which is not what a recap is: it is a *state of the session*, not a
 * contribution to it. pi puts it on a single muted line above the composer and
 * leaves it there, so it stays true while the conversation keeps scrolling.
 *
 * This module is the pure half: recognise a recap, bend it into at most two rows
 * of muted text, and parse `/recap-config`. The surface lives in `./chat-ui.ts`,
 * the routing in `./chat-stream.ts`, the command in `./chat-config.ts`.
 *
 * Nothing here talks to goose, so none of it decides whether a model call
 * happens: `/recap` is goose's command, always. A recap that is switched off
 * still runs — it simply stays in the transcript like any other answer.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

/** What goose prefixes a recap with (`ops_recap.rs`). Trailing `:` optional. */
export const RECAP_PREFIX = "※ recap";

/**
 * The line pi appends, naming the way out.
 */
export const RECAP_HINT = "(disable recaps in /recap-config)";

/**
 * What the head of an answer is, as far as it can be told yet.
 *
 * goose streams in very small chunks — a real run delivered `※`, ` recap`, `:`,
 * ` No`, … one at a time — so the first chunk alone cannot decide anything:
 * `"※"` is a prefix of the marker *and* the start of an answer that opens with a
 * footnote glyph. Waiting is what makes the decision correct; the block is
 * created only once the text can no longer be a recap.
 */
export type RecapHead = "recap" | "answer" | "undecided";

/**
 * Classify the head of a message.
 *
 * - `recap` — it starts with the marker (`※ recap`), colon optional.
 * - `undecided` — it is shorter than the marker and still a prefix of it
 *   (`※`, `※ re`, `※ reca`): the caller buffers and asks again.
 * - `answer` — anything else, including a lone `※` followed by other text.
 *
 * Measured after leading whitespace, because goose prefixes a `\n\n` between a
 * tool call and the text that follows it. Only the head is inspected: an answer
 * that merely quotes a recap further down is an answer.
 */
export function classifyRecapHead(text: string): RecapHead {
  const head = text.replace(/^\s+/, "");
  if (head === "") return "undecided";
  if (!head.startsWith("※")) return "answer";
  if (head.startsWith(RECAP_PREFIX)) {
    // The marker has to end: `※ recap:` and `※ recap …` are recaps,
    // `※ recapitulate …` is an answer that happens to start with it.
    const next = head.slice(RECAP_PREFIX.length, RECAP_PREFIX.length + 1);
    return next === "" || next === ":" || /\s/.test(next) ? "recap" : "answer";
  }
  return RECAP_PREFIX.startsWith(head) ? "undecided" : "answer";
}

/**
 * Does this answer begin with the recap marker? Strictly: only a complete
 * marker counts, so `isRecapText("※")` is false and the streaming decision is
 * `classifyRecapHead`'s job (it knows how to wait).
 */
export function isRecapText(text: string): boolean {
  return classifyRecapHead(text) === "recap";
}

/**
 * How many rows the recap may occupy on the surface.
 *
 * Two, not one: a recap says what happened *and* what to do next, and a single
 * row at 80 columns cuts the second half. Two, not five: the line sits above the
 * composer, where it competes with what the user is typing — a recap that grows
 * into a paragraph stops being read at a glance, which is the only thing it is
 * for. The model is asked for one or two sentences (`ops_recap.rs`); this is the
 * client-side guarantee for the runs where it does not comply.
 */
export const RECAP_MAX_ROWS = 2;

/**
 * How much of the body survives before it is elided, in visible columns.
 *
 * Sized so that at 80 columns the body *and* the way out still fit in two rows
 * (`2 × 79 − marker − hint ≈ 114`), with room to spare at 100. A longer body is
 * cut at a word boundary and marked with `…`, so the line always ends somewhere
 * a reader can see it stopped rather than ended.
 */
const RECAP_BODY_MAX = 150;

/**
 * The line the surface shows: `※ recap: <body> (disable recaps in
 * /recap-config)`.
 *
 * Everything after the marker is the body. Newlines and runs of spaces inside it
 * collapse to single spaces, and a trailing hint is dropped rather than doubled —
 * a recap restored from a transcript that already carries it would otherwise show
 * it twice.
 *
 * Markdown is flattened too, because a row of text is not a document: a model
 * that answers with `- **Thème Monokai** : …` would otherwise paint the asterisks
 * and backticks into the line. Bullets become `·` so the structure stays visible
 * without the syntax.
 */
export function buildRecapLine(text: string): string {
  const withoutHint = text.split(RECAP_HINT).join(" ");
  const body = limitBody(
    withoutHint
      .replace(/^\s*※\s*recap\s*:?\s*/i, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(^|\s)[-•]\s+/g, "$1· ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  if (!body) return `※ recap: ${RECAP_HINT}`;
  return `※ recap: ${body} ${RECAP_HINT}`;
}

/** Cut the body to `RECAP_BODY_MAX`, at a word boundary, marked with `…`. */
function limitBody(body: string): string {
  if (visibleWidth(body) <= RECAP_BODY_MAX) return body;
  const [head] = splitAtWidth(body, RECAP_BODY_MAX - 1);
  const atWord = head.replace(/\s+\S*$/, "").trimEnd();
  return `${atWord || head.trimEnd()}…`;
}


/**
 * Wrap the recap line to the surface's width, the way pi's `Text` widget does:
 * on spaces, one column of left padding on every row, never breaking a word
 * that fits on a row of its own.
 *
 * Stopping at `RECAP_MAX_ROWS` is the contract, not a courtesy: whatever the
 * model answers, the line above the composer stays two rows and the last one
 * ends with `…` so the cut is visible. Truncation happens here and not in
 * `buildRecapLine` because only the renderer knows the width — the same recap is
 * two rows at 100 columns and needs the `…` at 40.
 */
export function wrapRecapLine(line: string, width: number): string[] {
  const room = Math.max(1, width - 1);
  const trimmed = line.trimEnd();
  const hint = trimmed.endsWith(RECAP_HINT) ? RECAP_HINT : "";
  const rows = wrapWords(line, room);
  if (rows.length <= RECAP_MAX_ROWS) return rows;

  // Eliding: keep the way out if it can be kept. The hint is an affordance, and
  // a cut line that no longer says how to switch recaps off is a dead end.
  if (hint) {
    const withHint = elideAroundHint(trimmed.slice(0, trimmed.length - hint.length).trimEnd(), hint, room);
    if (withHint.length > 0) return withHint;
  }
  const kept = rows.slice(0, RECAP_MAX_ROWS);
  const [head] = splitAtWidth(kept[RECAP_MAX_ROWS - 1].slice(1), Math.max(1, room - 1));
  kept[RECAP_MAX_ROWS - 1] = ` ${head.trimEnd()}…`;
  return kept;
}

/**
 * Two rows of `body … (disable recaps in /recap-config)`.
 *
 * The body is cut to the columns the hint leaves, at a word boundary, and then
 * re-wrapped once or twice: a row budget in characters does not guarantee a row
 * count, because where a wrap falls depends on word lengths. `[]` means the
 * width is too narrow to hold both, and the caller elides without the hint.
 */
function elideAroundHint(body: string, hint: string, room: number): string[] {
  const suffix = ` … ${hint}`;
  const budget = RECAP_MAX_ROWS * room - visibleWidth(suffix);
  if (budget < 1) return [];
  let text = "";
  for (const word of body.split(/\s+/).filter((w) => w !== "")) {
    const candidate = text === "" ? word : `${text} ${word}`;
    if (visibleWidth(candidate) > budget) break;
    text = candidate;
  }
  if (text === "") return [];
  const tidy = (t: string) => t.replace(/[\s·,;:–-]+$/, "");
  text = tidy(text);
  if (text === "") return [];
  let rows = wrapWords(`${text}${suffix}`, room);
  while (rows.length > RECAP_MAX_ROWS && text.includes(" ")) {
    text = tidy(text.slice(0, text.lastIndexOf(" ")));
    rows = wrapWords(`${text}${suffix}`, room);
  }
  return rows.length <= RECAP_MAX_ROWS ? rows : [];
}

/** Every row the text needs: the plain greedy wrap, with no row cap. */
function wrapWords(line: string, room: number): string[] {
  const words = line.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [""];
  const rows: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (current !== "" && visibleWidth(candidate) > room) {
      rows.push(" " + current);
      current = word;
      // A single word longer than the row cannot be honoured: break it, so the
      // surface never paints past the edge.
      while (visibleWidth(current) > room) {
        const [head, tail] = splitAtWidth(current, room);
        rows.push(" " + head);
        current = tail;
      }
      continue;
    }
    current = candidate;
  }
  if (current !== "") rows.push(" " + current);
  return rows;
}

/** Split a word at the last column that fits, by code point (`[...s]`). */
function splitAtWidth(word: string, room: number): [string, string] {
  let head = "";
  for (const char of word) {
    if (visibleWidth(head + char) > room) break;
    head += char;
  }
  return [head, word.slice(head.length)];
}

// ─── Automatic recaps (`pi-recap`'s auto: true) ─────────────────────────────

/**
 * pi arms a timer when a turn ends and runs the recap itself if the session is
 * still idle `idleAfterTurnMs` later (`scheduleAutoRecap`), cancelling it on any
 * input or on the next turn. rossii does the same, except the work is goose's
 * `/recap`: the timer sends that command quietly, so it costs one turn and one
 * model call, not a client-side transcript of its own.
 *
 * The two guards are pi's own: a session needs `minSessionTurns` user turns
 * before it earns a recap, and nothing is generated when no turn happened since
 * the last one (`neverTwiceInARow`).
 */
export const RECAP_AUTO_DELAY_MS = 30_000;
export const RECAP_MIN_TURNS = 3;

/** Everything the trigger reads. Pure, so `tests/recap.test.ts` can pin it. */
export interface RecapTriggerState {
  /** `/recap-config on` — the surface, and the only thing that gates recaps. */
  enabled: boolean;
  /** `/recap-config auto on` — generate without being asked. */
  auto: boolean;
  /** A turn is running: the agent is not idle. */
  busy: boolean;
  /** A permission prompt is waiting for the user: not idle either. */
  permissionOpen: boolean;
  /** What the composer holds; a draft means the user is in the middle of one. */
  draft: string;
  /** User turns this transcript has shown (`ctx.turnsStarted`). */
  turns: number;
  /** `turns` when the last recap was produced — `neverTwiceInARow`. */
  lastRecapTurn: number;
}

/**
 * Should the idle timer generate a recap now?
 *
 * Every clause is a reason *not* to: recaps switched off, automatic generation
 * switched off, a turn still running, a permission dialog open, a draft in the
 * composer, a session too short to have anything to sum up, or no turn since the
 * last recap. A timer that fires and is refused is not rescheduled — the next
 * turn end arms it again, which is exactly what pi does.
 */
export function shouldAutoRecap(state: RecapTriggerState): boolean {
  if (!state.enabled || !state.auto) return false;
  if (state.busy || state.permissionOpen) return false;
  if (state.draft.trim() !== "") return false;
  if (state.turns < RECAP_MIN_TURNS) return false;
  return state.turns > state.lastRecapTurn;
}

/**
 * Is this text the `/recap` command? A recap request is not a message the user
 * wrote, so it is not echoed in the transcript (`❯ /recap`) and a replayed one is
 * skipped: the line above the composer is what it produced.
 */
export function isRecapCommand(text: string): boolean {
  return text.trim().replace(/^\/+/, "").toLowerCase() === "recap";
}

/** What `/recap-config` accepts. */
export type RecapConfigAction =
  | { kind: "show" }
  | { kind: "set-enabled"; enabled: boolean }
  | { kind: "toggle-enabled" }
  | { kind: "set-auto"; auto: boolean }
  | { kind: "toggle-auto" }
  | { kind: "set-delay"; ms: number }
  | { kind: "error"; message: string };

/**
 * Parse `/recap-config [on|off|toggle|auto …]`.
 *
 * Bare `/recap-config` shows the state. `on`/`off`/`toggle` set the surface,
 * `auto on|off|toggle` the automatic generation, and `auto <delay>` the idle
 * delay (`30s`, `2m`, `off` for never) — the same units as `/timeout`.
 */
export function parseRecapConfigCommand(args: readonly string[]): RecapConfigAction {
  const words = args.map((arg) => arg.trim()).filter((arg) => arg !== "");
  const [first, ...rest] = words;
  const head = first?.toLowerCase();
  if (head === undefined) return { kind: "show" };

  if (head === "auto") {
    const value = rest[0]?.toLowerCase();
    if (value === undefined) return { kind: "toggle-auto" };
    if (rest.length > 1) return tooMany("`/recap-config auto` takes one value: `on`, `off` or a delay.");
    if (value === "on" || value === "enable") return { kind: "set-auto", auto: true };
    if (value === "off" || value === "disable") return { kind: "set-auto", auto: false };
    const delay = parseDelay(words.slice(1).join(""));
    if ("error" in delay) return { kind: "error", message: delay.error };
    return { kind: "set-delay", ms: delay.ms };
  }

  if (rest.length > 0) return tooMany("`/recap-config` takes one word: `on`, `off`, `toggle` or `auto`.");
  if (head === "on" || head === "enable") return { kind: "set-enabled", enabled: true };
  if (head === "off" || head === "disable") return { kind: "set-enabled", enabled: false };
  if (head === "toggle") return { kind: "toggle-enabled" };
  return {
    kind: "error",
    message: `Unknown \`/recap-config\` value \`${first}\`: use \`on\`, \`off\`, \`toggle\` or \`auto\`.`,
  };
}

function tooMany(message: string): { kind: "error"; message: string } {
  return { kind: "error", message };
}

/** `30s`, `2m`, `45000`, `off` (0 = never) — `/timeout`'s grammar, one unit set. */
export function parseDelay(raw: string): { ms: number } | { error: string } {
  const text = raw.trim().toLowerCase();
  if (!text) return { error: "expected a delay: 30s, 2m, 45000 (milliseconds) or off" };
  if (["off", "never", "none", "no"].includes(text)) return { ms: 0 };
  const withUnit = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text);
  if (withUnit) {
    const factors = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
    const unit = withUnit[2] as keyof typeof factors;
    return { ms: Math.round(Number(withUnit[1]) * factors[unit]) };
  }
  if (/^\d+$/.test(text)) return { ms: Number(text) };
  return { error: `"${raw.trim()}" is not a delay — use 30s, 2m, 45000 (ms) or off` };
}

/** One-line description of the current state, for `/recap-config` and its menu. */
export function describeRecapState(
  enabled: boolean,
  auto = true,
  idleMs = RECAP_AUTO_DELAY_MS,
): string {
  const line = enabled
    ? "Recaps: on — `/recap` puts its one-line recap above the composer."
    : "Recaps: off — `/recap` still runs, its answer stays in the transcript.";
  if (!enabled) return line;
  const automatic = auto
    ? idleMs > 0
      ? `Automatic: on after ${formatDelay(idleMs)} idle`
      : "Automatic: off (the delay is 0)"
    : "Automatic: off";
  return `${line} ${automatic} (${RECAP_MIN_TURNS} turns minimum, never twice in a row).`;
}

/** `30s`, `2m 30s`, `45m` — the delay as a person would say it. */
export function formatDelay(ms: number): string {
  if (ms <= 0) return "0s";
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}
