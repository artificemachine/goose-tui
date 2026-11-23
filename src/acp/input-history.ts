/**
 * Composer input history — the recipes zsh gives you for free: Up/Down recall,
 * `HIST_IGNORE_SPACE`, consecutive-duplicate suppression, a size cap, and the
 * list the Ctrl+R search reads.
 *
 * pi-tui's `Editor` already browses history with Up/Down (`navigateHistory`),
 * but its list lives in the `Editor` instance: it is capped at 100 and dies
 * with the chat. rossii never called `addToHistory()`, so the arrows did
 * nothing at all. This module is the part the `Editor` cannot own:
 *
 * - the on-disk list, one JSON string per line, so a quoted multi-line prompt
 *   survives as one entry (`~/.config/rossii/projects/<dir>-<hash>.history.jsonl`,
 *   same key as the project meta — `getProjectHistoryPath` in ../project.ts);
 * - the ordering the `Editor` expects (`addToHistory` unshifts, so the file is
 *   replayed oldest first);
 * - the rules that keep the list useful (no blanks, no consecutive duplicates).
 *
 * Pure and file-free, like ./command-complete.ts: everything that can be tested
 * without a terminal is tested in scripts/acp-input-history-test.ts. The fs
 * helpers below are the only I/O, and they never throw — a broken history file
 * costs the history, never the chat.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Default cap, in entries. */
export const DEFAULT_HISTORY_LIMIT = 1000;

export interface RecordOptions {
  /**
   * zsh's `HIST_IGNORE_SPACE`: an entry that starts with a space is not
   * recorded, so a one-off command can be typed without polluting the list.
   */
  ignoreInitialSpace?: boolean;
}

export class InputHistory {
  /** Oldest first. */
  private entries: string[];
  private readonly limit: number;
  private index: number | null = null;
  private draft = "";

  constructor(entries: readonly string[] = [], limit: number = DEFAULT_HISTORY_LIMIT) {
    this.limit = Math.max(1, Math.trunc(limit));
    this.entries = entries.filter((entry) => entry.trim() !== "").slice(-this.limit);
  }

  get size(): number {
    return this.entries.length;
  }

  /** Oldest first — the shape `suggestSuffix` scans from the end. */
  all(): readonly string[] {
    return this.entries;
  }

  /** Newest first — the shape a Ctrl+R overlay lists. */
  recent(): readonly string[] {
    return [...this.entries].reverse();
  }

  record(entry: string, options: RecordOptions = {}): boolean {
    if (entry.trim() === "") return false;
    if (options.ignoreInitialSpace === true && entry.startsWith(" ")) return false;
    if (this.entries[this.entries.length - 1] === entry) return false;
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries = this.entries.slice(-this.limit);
    this.reset();
    return true;
  }

  /** Up: one step back, remembering the draft so Down can come back to it. */
  previous(current: string): string | null {
    if (this.entries.length === 0) return null;
    if (this.index === null) {
      this.draft = current;
      this.index = this.entries.length - 1;
    } else if (this.index > 0) {
      this.index -= 1;
    }
    return this.entries[this.index] ?? null;
  }

  /** Down: one step forward, then the draft once past the newest entry. */
  next(): string | null {
    if (this.index === null) return null;
    if (this.index < this.entries.length - 1) {
      this.index += 1;
      return this.entries[this.index] ?? null;
    }
    this.index = null;
    return this.draft;
  }

  /** Ctrl+R: reverse substring search, newest first. An empty query lists everything. */
  search(query: string, limit = 50): string[] {
    const needle = query.toLowerCase();
    const found: string[] = [];
    for (let i = this.entries.length - 1; i >= 0 && found.length < limit; i -= 1) {
      const entry = this.entries[i]!;
      if (needle === "" || entry.toLowerCase().includes(needle)) found.push(entry);
    }
    return found;
  }

  /** Forget the navigation cursor. Called after a submit, a clear and a recall. */
  reset(): void {
    this.index = null;
    this.draft = "";
  }

  /** One JSON string per line, oldest first. */
  toLines(): string[] {
    return this.entries.map((entry) => JSON.stringify(entry));
  }

  static fromLines(lines: readonly string[]): InputHistory {
    const entries: string[] = [];
    for (const line of lines) {
      const text = line.trim();
      if (text === "") continue;
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "string") entries.push(parsed);
      } catch {
        // A truncated or hand-edited line costs one entry, never the whole file.
      }
    }
    return new InputHistory(entries);
  }
}

// ─── Disk ────────────────────────────────────────────────────────────────────

/**
 * Read the history for a project. A missing file is an empty history — that is
 * the first run, not an error — and an unreadable one is reported by the caller
 * only if it wants to.
 */
export function loadInputHistory(path: string, limit: number = DEFAULT_HISTORY_LIMIT): InputHistory {
  if (!existsSync(path)) return new InputHistory([], limit);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return new InputHistory([], limit);
  }
  const history = InputHistory.fromLines(raw.split("\n"));
  // Compact a file that outgrew the cap: the in-memory list is already trimmed.
  if (history.size > limit) writeInputHistory(path, new InputHistory(history.all().slice(-limit), limit));
  return history;
}

/** Rewrite the whole file. Used at compaction and, cheaply, at shutdown. */
export function writeInputHistory(path: string, history: InputHistory): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, history.toLines().join("\n") + "\n");
  } catch {
    // History is a convenience: a read-only config dir must not break a chat.
  }
}

/**
 * Append one entry. O(1) per submitted prompt, which is why the chat uses this
 * instead of rewriting the file; the cap is enforced in memory and the file is
 * compacted on the next load.
 */
export function appendInputHistory(path: string, entry: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {
    // Same trade as writeInputHistory.
  }
}
