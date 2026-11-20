#!/usr/bin/env bun
/**
 * Unit tests for the colour themes (src/theme.ts) and the `/theme` command.
 *
 * Pins:
 *   - the default theme leaves picocolors' own output untouched;
 *   - switching a theme changes what every importer of `./theme` prints,
 *     including a colour function captured before the switch (`hintAccent`);
 *   - unknown names are refused and leave the current theme in place;
 *   - nested colours re-open the outer colour after the inner one closes;
 *   - the choice survives a restart (saved file), and a corrupt file is ignored;
 *   - `/theme` is offered in the composer's command list.
 *
 * No TUI, no goose, no `~/.config/rossii`: persistence uses a temp directory.
 *
 * Usage: bun scripts/theme-test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// picocolors decides colour support when it is first imported.
process.env.FORCE_COLOR = "1";
delete process.env.NO_COLOR;

const base = (await import("picocolors")).default;
const theme = await import("../src/theme");
const { hintAccent } = await import("../src/utils");
const { CHAT_COMMANDS } = await import("../src/acp/command-complete");
const pc = theme.default;

let failed = 0;
let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`❌ ${name}`);
    console.log(error);
  }
}

const truecolor = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};

check("the default theme prints exactly what picocolors prints", () => {
  assert.equal(theme.getTheme(), "default");
  assert.equal(pc.cyan("x"), base.cyan("x"));
  assert.equal(pc.red("x"), base.red("x"));
  assert.equal(pc.dim("x"), base.dim("x"));
});

check("a named theme recolours every importer, case-insensitively", () => {
  assert.equal(theme.setTheme("Dracula", null), true);
  assert.equal(theme.getTheme(), "dracula");
  assert.equal(pc.cyan("x"), `${truecolor(theme.THEMES.dracula.cyan)}x\x1b[39m`);
  assert.equal(pc.dim("x"), base.dim("x"), "non-colour styles are left alone");
});

check("a colour function captured before the switch follows the theme", () => {
  theme.setTheme("nord", null);
  assert.equal(hintAccent("x"), `${truecolor(theme.THEMES.nord.cyan)}x\x1b[39m`);
});

check("an unknown theme is refused and the current one stays", () => {
  theme.setTheme("nord", null);
  assert.equal(theme.setTheme("solarized-nope", null), false);
  assert.equal(theme.getTheme(), "nord");
});

check("nested colours re-open the outer colour after the inner one", () => {
  theme.setTheme("goose", null);
  const out = pc.cyan(`a${pc.red("b")}c`);
  const cyan = truecolor(theme.THEMES.goose.cyan);
  const red = truecolor(theme.THEMES.goose.red);
  assert.equal(out, `${cyan}a${red}b\x1b[39m${cyan}c\x1b[39m`);
});

check("back to default restores picocolors' output", () => {
  theme.setTheme("default", null);
  assert.equal(pc.cyan("x"), base.cyan("x"));
});

check("the choice is saved and read back on the next start", () => {
  const dir = mkdtempSync(join(tmpdir(), "rossii-theme-"));
  assert.equal(theme.setTheme("light", dir), true);
  assert.equal(readFileSync(join(dir, "theme"), "utf-8").trim(), "light");
  theme.setTheme("default", null);
  assert.equal(theme.loadSavedTheme(dir), "light");
  assert.equal(theme.getTheme(), "light");
  theme.setTheme("default", null);
});

check("retrowave selection persists", () => {
  const dir = mkdtempSync(join(tmpdir(), "rossii-theme-"));
  assert.equal(theme.setTheme("retrowave", dir), true);
  theme.setTheme("default", null);
  assert.equal(theme.loadSavedTheme(dir), "retrowave");
  theme.setTheme("default", null);
});

check("a corrupt or missing saved theme falls back to default", () => {
  const dir = mkdtempSync(join(tmpdir(), "rossii-theme-"));
  assert.equal(theme.loadSavedTheme(dir), "default");
  writeFileSync(join(dir, "theme"), "not-a-theme\n");
  assert.equal(theme.loadSavedTheme(dir), "default");
  assert.equal(theme.getTheme(), "default");
});

check("every theme defines the six colours picocolors offers", () => {
  for (const name of theme.THEME_NAMES) {
    if (name === "default") continue;
    const palette = theme.THEMES[name as keyof typeof theme.THEMES];
    for (const key of ["red", "green", "yellow", "blue", "magenta", "cyan"] as const) {
      assert.match(palette[key], /^#[0-9A-Fa-f]{6}$/, `${name}.${key}`);
    }
  }
});

check("/theme is offered in the composer's command list", () => {
  assert.ok(CHAT_COMMANDS.some((item) => item.value === "theme"));
});

console.log(failed === 0 ? `\n✅ all ${passed} checks passed` : `\n❌ ${failed} of ${passed + failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
