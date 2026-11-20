/**
 * Colour themes (`src/theme.ts`): the tests
 * `docs/specs/SPEC-002-themes.md` binds to.
 *
 * Every test saves into its own throwaway config directory.
 * Usage: bun test tests/
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { THEME_NAMES, getTheme, loadSavedTheme, setTheme } from "../src/theme";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "goose-tui-theme-"));
  setTheme("default", null);
});

afterEach(() => {
  setTheme("default", null);
  rmSync(dir, { recursive: true, force: true });
});

/** Run `fn` with stderr captured, and return what it printed. */
function captureStderr(fn: () => void): string {
  const original = console.error;
  let printed = "";
  console.error = (...args: unknown[]) => { printed += args.map(String).join(" ") + "\n"; };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return printed;
}

test("theme_choice_is_saved_and_restored", () => {
  expect(setTheme("Retrowave", dir)).toBe(true);
  expect(getTheme()).toBe("retrowave");
  expect(readFileSync(join(dir, "theme"), "utf8")).toBe("retrowave\n");

  // A new start: the process comes up on the default, then loads the saved one.
  setTheme("default", null);
  expect(loadSavedTheme(dir)).toBe("retrowave");
  expect(getTheme()).toBe("retrowave");
});

test("unknown_theme_is_refused_and_changes_nothing", () => {
  setTheme("nord", dir);
  expect(setTheme("neon", dir)).toBe(false);
  expect(getTheme()).toBe("nord");
  expect(readFileSync(join(dir, "theme"), "utf8")).toBe("nord\n");
});

test("every_listed_theme_can_be_selected", () => {
  expect(THEME_NAMES).toEqual(["default", "goose", "opencode", "retrowave", "dracula", "nord", "light"]);
  for (const name of THEME_NAMES) {
    expect(setTheme(name, null)).toBe(true);
    expect(getTheme()).toBe(name);
  }
  // Applying without a config directory writes nothing.
  expect(existsSync(join(dir, "theme"))).toBe(false);
});

test("unusable_saved_theme_falls_back_to_default", () => {
  // No file at all: default, silently.
  expect(captureStderr(() => expect(loadSavedTheme(dir)).toBe("default"))).toBe("");

  // An unknown name: default, and the user is told why.
  setTheme("dracula", null);
  writeFileSync(join(dir, "theme"), "neon\n");
  const warned = captureStderr(() => expect(loadSavedTheme(dir)).toBe("default"));
  expect(getTheme()).toBe("default");
  expect(warned).toContain('unknown saved theme "neon"');
});
