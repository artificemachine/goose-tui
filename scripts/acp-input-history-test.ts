#!/usr/bin/env bun
/**
 * Unit tests for the composer's input history and inline autosuggestion
 * (src/acp/input-history.ts, src/acp/autosuggest.ts).
 *
 * What is pinned:
 *
 * - the recording rules: blanks dropped, a consecutive duplicate dropped (a
 *   later repeat is kept), `HIST_IGNORE_SPACE` honoured, the cap enforced
 * - Up/Down: the draft survives the round trip, Up at the oldest entry stops
 *   rather than wrapping, Down past the newest restores the draft
 * - Ctrl+R search: reverse order, substring, case-insensitive, empty query
 *   lists everything
 * - the on-disk round trip: JSON per line, a broken line costs one entry
 * - the suggestion rules: only from a prefix, only at the end of the line,
 *   never under the `/…` menu, newest match wins, the suffix is a suffix
 *
 * Usage: bun run test:input-history   (or `bun run test`)
 */

import assert from "node:assert/strict";

import { acceptSuggestion, suggestSuffix } from "../src/acp/autosuggest";
import { DEFAULT_HISTORY_LIMIT, InputHistory } from "../src/acp/input-history";

type Check = [name: string, run: () => void];

const checks: Check[] = [];

const ok = (name: string, run: () => void): void => {
  checks.push([name, run]);
};

// ─── Recording ──────────────────────────────────────────────────────────────

ok("blank entries are ignored", () => {
  const history = new InputHistory();
  history.record("");
  history.record("   ");
  history.record("\n\t");
  assert.equal(history.size, 0);
});

ok("a consecutive duplicate is dropped, a later repeat is kept", () => {
  const history = new InputHistory();
  history.record("goose");
  history.record("goose");
  history.record("rossii");
  history.record("goose");
  assert.deepEqual([...history.all()], ["goose", "rossii", "goose"]);
});

ok("HIST_IGNORE_SPACE: a leading space keeps the entry out", () => {
  const history = new InputHistory();
  assert.equal(history.record(" secret", { ignoreInitialSpace: true }), false);
  assert.equal(history.record("shown"), true);
  assert.deepEqual([...history.all()], ["shown"]);
});

ok("without the option a leading space is recorded as typed", () => {
  const history = new InputHistory();
  history.record(" indented");
  assert.deepEqual([...history.all()], [" indented"]);
});

ok("the cap keeps the newest entries", () => {
  const history = new InputHistory([], 3);
  for (const entry of ["1", "2", "3", "4"]) history.record(entry);
  assert.deepEqual([...history.all()], ["2", "3", "4"]);
});

ok("the constructor applies the cap and drops blanks", () => {
  const history = new InputHistory(["a", "  ", "b", "c", "d"], 2);
  assert.deepEqual([...history.all()], ["c", "d"]);
  assert.equal(new InputHistory([], 0).size, 0);
  assert.equal(DEFAULT_HISTORY_LIMIT, 1000);
});

// ─── Up / Down ──────────────────────────────────────────────────────────────

ok("Up walks back and stops at the oldest entry", () => {
  const history = new InputHistory(["one", "two"]);
  assert.equal(history.previous("draft"), "two");
  assert.equal(history.previous("two"), "one");
  assert.equal(history.previous("one"), "one");
});

ok("Down walks forward and restores the draft", () => {
  const history = new InputHistory(["one", "two"]);
  history.previous("draft");
  history.previous("two");
  assert.equal(history.next(), "two");
  assert.equal(history.next(), "draft");
  assert.equal(history.next(), null);
});

ok("Up and Down on an empty history do nothing", () => {
  const history = new InputHistory();
  assert.equal(history.previous("draft"), null);
  assert.equal(history.next(), null);
});

ok("recording resets the navigation cursor", () => {
  const history = new InputHistory(["one"]);
  history.previous("draft");
  history.record("two");
  // Back at the bottom: the next Up starts from the newest entry.
  assert.equal(history.previous("draft"), "two");
});

// ─── Ctrl+R ─────────────────────────────────────────────────────────────────

ok("search is reverse, substring and case-insensitive", () => {
  const history = new InputHistory(["git status", "Git log", "npm test"]);
  assert.deepEqual(history.search("git"), ["Git log", "git status"]);
  assert.deepEqual(history.search("GIT"), ["Git log", "git status"]);
  assert.deepEqual(history.search("t"), ["npm test", "Git log", "git status"]);
  assert.deepEqual(history.search("zzz"), []);
});

ok("an empty search lists everything, newest first, up to the limit", () => {
  const history = new InputHistory(["a", "b", "c"]);
  assert.deepEqual(history.recent(), ["c", "b", "a"]);
  assert.deepEqual(history.search(""), ["c", "b", "a"]);
  assert.deepEqual(history.search("", 2), ["c", "b"]);
});

// ─── Disk shape ─────────────────────────────────────────────────────────────

ok("toLines / fromLines round-trips a quoted and a multi-line entry", () => {
  const history = new InputHistory(['say "hi"', "line one\nline two"]);
  const restored = InputHistory.fromLines(history.toLines());
  assert.deepEqual([...restored.all()], ['say "hi"', "line one\nline two"]);
});

ok("a broken or hand-edited line costs one entry, not the file", () => {
  const lines = [JSON.stringify("kept"), "{not json}", JSON.stringify(42), "", JSON.stringify("also kept")];
  assert.deepEqual([...InputHistory.fromLines(lines).all()], ["kept", "also kept"]);
});

// ─── Autosuggestion ─────────────────────────────────────────────────────────

const HISTORY = ["git log --oneline", "git status", "npm test"];

ok("the newest matching prefix wins", () => {
  assert.equal(suggestSuffix("git ", HISTORY), "status");
  assert.equal(suggestSuffix("g", HISTORY), "it status");
  assert.equal(suggestSuffix("np", HISTORY), "m test");
});

ok("the suggestion is the suffix, never the whole line", () => {
  assert.equal(suggestSuffix("git s", HISTORY), "tatus");
  assert.equal(acceptSuggestion("git s", "tatus"), "git status");
});

ok("nothing is suggested when the input is not a prefix", () => {
  assert.equal(suggestSuffix("xyz", HISTORY), null);
  assert.equal(suggestSuffix("git log --oneline", HISTORY), null);
});

ok("nothing is suggested for an empty or whitespace-only line", () => {
  assert.equal(suggestSuffix("", HISTORY), null);
  assert.equal(suggestSuffix("   ", HISTORY), null);
});

ok("nothing is suggested unless the cursor is at the end", () => {
  assert.equal(suggestSuffix("git", HISTORY, { cursorAtEnd: true }), " status");
  assert.equal(suggestSuffix("git", HISTORY, { cursorAtEnd: false }), null);
});

ok("nothing is suggested while the / menu is open", () => {
  assert.equal(suggestSuffix("/mo", ["/model fetch"], { menuOpen: true }), null);
  assert.equal(suggestSuffix("/mo", ["/model fetch"]), "del fetch");
});

ok("accepting a null suffix leaves the input alone", () => {
  assert.equal(acceptSuggestion("git s", null), "git s");
});

// ─── runner ─────────────────────────────────────────────────────────────────

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
