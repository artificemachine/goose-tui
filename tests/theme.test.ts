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

import {
  STATUS_CHIPS,
  THEME_NAMES,
  getTheme,
  loadSavedTheme,
  setTheme,
  themeChrome,
  type ThemeChrome,
} from "../src/theme";

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
  expect(THEME_NAMES).toEqual(["default", "goose", "opencode", "retrowave", "retrowave2", "monokai", "dracula", "nord", "light"]);
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

/**
 * The chrome ladder, measured rather than eyeballed.
 *
 * Retrowave defines the shape of a conversation: agent prose on the darkest
 * band, tool calls on a blue one above it, shell output on the coloured one on
 * top, the user's own message on the one light (mauve) surface. Every theme that
 * paints chrome must reproduce that *order of lightness* and those colour
 * families — only the hue changes — or switching themes would silently re-rank
 * the sections. These tests are the guard: change a band and they say which
 * step of the ladder broke.
 */

type Rgb = [number, number, number];

function parseRgb(triple: string): Rgb {
  const parts = triple.split(";").map(Number);
  expect(parts).toHaveLength(3);
  for (const channel of parts) {
    expect(Number.isInteger(channel) && channel >= 0 && channel <= 255).toBe(true);
  }
  return parts as Rgb;
}

function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(triple: string): number {
  const [r, g, b] = parseRgb(triple);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** CIE L*: perceptual lightness, 0 (black) to 100 (white). */
function lightness(triple: string): number {
  const y = luminance(triple);
  return 116 * (y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116) - 16;
}

/** Hue in degrees, HSL — enough to tell green from blue from mauve. */
function hue(triple: string): number {
  const [r, g, b] = parseRgb(triple).map((value) => value / 255) as Rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let h: number;
  if (max === r) h = (g - b) / delta + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  return h * 60;
}

function saturation(triple: string): number {
  const [r, g, b] = parseRgb(triple).map((value) => value / 255) as Rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  const l = (max + min) / 2;
  return (l > 0.5 ? delta / (2 - max - min) : delta / (max + min)) * 100;
}

/** WCAG contrast ratio between two colours. */
function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/** Assert a measurement *and* name the theme and band when it leaves the ladder. */
function expectWithin(theme: string, role: string, value: number, min: number, max: number): void {
  expect({ theme, role, lightnessOrHue: value, within: min, and: max, holds: value >= min && value <= max })
    .toEqual({ theme, role, lightnessOrHue: value, within: min, and: max, holds: true });
}

/** The chrome of every theme that paints one, keyed by theme name. */
function chromeThemes(): Array<[string, ThemeChrome]> {
  const entries: Array<[string, ThemeChrome]> = [];
  for (const name of THEME_NAMES) {
    setTheme(name, null);
    const chrome = themeChrome();
    if (chrome) entries.push([name, chrome]);
  }
  return entries;
}

test("at_least_retrowave_and_monokai_paint_chrome", () => {
  const names = chromeThemes().map(([name]) => name);
  expect(names).toContain("retrowave");
  expect(names).toContain("monokai");
});

test("every_chrome_theme_keeps_a_three_step_band_ladder", () => {
  for (const [name, chrome] of chromeThemes()) {
    const bands = [chrome.agentBand, chrome.toolBand, chrome.shellBand];
    const steps = bands.map(lightness).sort((a, b) => a - b);
    const user = lightness(chrome.userBand);
    const prompt = lightness(chrome.promptBg);

    // Three bands of a conversation, three steps and never one surface: the
    // shell band on top, the tool band below it, the answer band last. None of
    // them may climb into the light range — the shell band is a *mid* tone in
    // the retrowave themes (the owner's teal `#0081B0`, L* 50.5) and 55 is the
    // ceiling that keeps it a band rather than a second user surface.
    for (const [index, step] of steps.entries()) {
      expectWithin(name, `band${index}`, step, 0, 55);
    }
    expectWithin(name, "band steps", steps[1]! - steps[0]!, 5, 100);
    expectWithin(name, "band steps (top)", steps[2]! - steps[1]!, 5, 100);

    // The user band is the one light surface, far from every other one.
    expectWithin(name, "userBand", user, 60, 100);
    expectWithin(name, "userBand-lightestBand", user - steps[2]!, 18, 100);

    // The composer is a dark surface of its own: never one of the three bands,
    // never as light as the user band.
    expectWithin(name, "promptBg", prompt, 0, 20);
    for (const [index, band] of bands.entries()) {
      expectWithin(name, `promptBg-band${index}`, Math.abs(prompt - lightness(band)), 2, 100);
    }
  }
});

test("every_chrome_theme_keeps_each_section_on_its_own_colour", () => {
  for (const [name, chrome] of chromeThemes()) {
    // One slot per section, in every theme: answers on the black band, tool
    // calls on the blue one, shell output on the green one, the user's own
    // message on the mauve one. A theme may change the hue — Monokai's black is
    // warm, its green lime-tinted — but never the slot: switching themes must
    // not re-rank the conversation or turn an answer into the user's band.
    // Answers are the darkest surface, but "darkest" is not "black": retrowave
    // lifts them to the owner's slate `#323240` (L* 21.3) and keeps the tool
    // band ten L* above (`#204F65`, L* 31.4). The cap below is what stops an
    // answer band from becoming a tool band (the ladder test enforces the gap
    // itself, and the tool band's own hue/saturation keep it blue).
    expectWithin(name, "agentBand saturation", saturation(chrome.agentBand), 0, 20);
    expectWithin(name, "agentBand lightness", lightness(chrome.agentBand), 0, 25);

    expectWithin(name, "toolBand hue", hue(chrome.toolBand), 180, 235);
    expectWithin(name, "toolBand saturation", saturation(chrome.toolBand), 25, 100);
    // The shell family runs green (monokai's lime, hue 95) through teal to blue
    // (retrowave's `#0081B0`, hue 196). It overlaps the tool family, so the two
    // bands must stay separable some other way: a wide hue gap or a clear step
    // of lightness. Retrowave separates them by lightness (34.5 L*), monokai by
    // hue (109°), and neither may collapse to both-at-once.
    expectWithin(name, "shellBand hue", hue(chrome.shellBand), 70, 215);
    expectWithin(name, "shellBand saturation", saturation(chrome.shellBand), 25, 100);
    const hueGap = Math.abs(hue(chrome.shellBand) - hue(chrome.toolBand));
    const hueSeparation = Math.min(hueGap, 360 - hueGap);
    const lightSeparation = lightness(chrome.shellBand) - lightness(chrome.toolBand);
    const separable = hueSeparation >= 20 || lightSeparation >= 15;
    expect({ theme: name, hueSeparation, lightSeparation, separable }).toEqual({
      theme: name,
      hueSeparation,
      lightSeparation,
      separable: true,
    });

    expectWithin(name, "userBand hue", hue(chrome.userBand), 245, 300);
  }
});

test("the_shell_band_carries_a_legible_foreground_when_it_is_a_mid_tone", () => {
  for (const [name, chrome] of chromeThemes()) {
    if (!chrome.shellBandFg) continue;
    // `#0081B0` tops out at 4.41:1 with pure white, so this asserts the best the
    // colour allows rather than an AA it cannot reach — and it fails the moment
    // the band gets lighter or the foreground gets darker than white.
    expectWithin(name, "shellBandFg contrast", contrast(chrome.shellBandFg, chrome.shellBand), 4.4, 21);
  }
});

test("the_user_band_carries_a_legible_foreground", () => {
  for (const [, chrome] of chromeThemes()) {
    // The light band needs its own dark text: WCAG AAA for large text.
    expectWithin("userBandFg", "lightness", lightness(chrome.userBandFg), 0, 15);
    expectWithin("userBand", "contrast-on-userBandFg", contrast(chrome.userBand, chrome.userBandFg), 7, 21);
  }
});

/**
 * The status bar is a powerline strip, not a band: it paints no background (the
 * separator glyphs are foregrounds and every chip closes with a full reset), so
 * the theme only colours the text. The chips themselves are the reference HUD's
 * neutral greys — identical in every theme — and the text must clear AA on the
 * lightest of them, which is why the third step is a shade darker than the
 * reference's `#707070`.
 */
test("the_status_chips_are_the_reference_neutral_ladder", () => {
  expect(STATUS_CHIPS).toEqual(["48;48;48", "85;85;85", "98;98;98", "65;65;65"]);
  // Neutral means neutral: no hue to speak of, in every chip.
  for (const [index, chip] of STATUS_CHIPS.entries()) {
    expectWithin("status", `chip${index} saturation`, saturation(chip), 0, 2);
  }
});

test("the_status_text_clears_aa_on_every_chip", () => {
  for (const [name, chrome] of chromeThemes()) {
    for (const [index, chip] of STATUS_CHIPS.entries()) {
      // The lightest chip is the worst case: the theme's own text colour has to
      // stay readable there, or the bar is unreadable whatever the hue.
      expectWithin(name, `chip${index} contrast`, contrast(chip, chrome.statusFg), 4.5, 21);
    }
  }
});
