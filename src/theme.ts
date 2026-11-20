/**
 * Colour themes.
 *
 * rossii colours its output with picocolors' six named colours (`pc.cyan`,
 * `pc.yellow`, …) at about 160 call sites. Rather than touch each of them, every
 * module imports `pc` from here: a copy of picocolors whose six colour
 * functions are swapped for the active theme's 24-bit colours. `setTheme`
 * rewrites those functions in place, so every importer sees the change at once,
 * including a function captured earlier (see `hintAccent` in ./utils.ts) as long
 * as it calls through `pc`.
 *
 * `default` keeps picocolors' own output (the terminal's palette). Styles
 * (bold, dim, italic, …) are unchanged. Retrowave also styles the prompt surface. Text printed before a
 * switch keeps its colours: they are baked into the transcript strings.
 *
 * The choice is saved as a bare name in `<rossii config dir>/theme`.
 */

import base from "picocolors";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ColorKey = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan";
type Palette = Record<ColorKey, string>;

const COLOR_KEYS: readonly ColorKey[] = ["red", "green", "yellow", "blue", "magenta", "cyan"];

/** Foreground reset, the same close code picocolors uses for every colour. */
const CLOSE = "\x1b[39m";

export const THEMES = {
  // goose's own TUI palette: cranberry accent, teal for success, gold highlights.
  goose: { red: "#C0354A", green: "#3A7D7B", yellow: "#C4883A", blue: "#8FA4BD", magenta: "#B07AA1", cyan: "#C0354A" },
  // Approximation of opencode's default dark palette.
  opencode: { red: "#E06C75", green: "#7FD88F", yellow: "#FAB283", blue: "#5C9CF5", magenta: "#9D7CD8", cyan: "#56B6C2" },
  retrowave: { red: "#F7768E", green: "#73DACA", yellow: "#FF9E64", blue: "#7DCFFF", magenta: "#BB9AF7", cyan: "#FF79C6" },
  dracula: { red: "#FF5555", green: "#50FA7B", yellow: "#F1FA8C", blue: "#BD93F9", magenta: "#FF79C6", cyan: "#8BE9FD" },
  nord: { red: "#BF616A", green: "#A3BE8C", yellow: "#EBCB8B", blue: "#81A1C1", magenta: "#B48EAD", cyan: "#88C0D0" },
  // For light terminal backgrounds.
  light: { red: "#B3263E", green: "#1F7A6D", yellow: "#A8691A", blue: "#0550AE", magenta: "#8250DF", cyan: "#1B7C83" },
} as const satisfies Record<string, Palette>;

export type ThemeName = "default" | keyof typeof THEMES;

export const THEME_NAMES: readonly ThemeName[] = ["default", ...(Object.keys(THEMES) as (keyof typeof THEMES)[])];

const THEME_FILE = "theme";

/** The `pc` every module uses. Mutated in place by `setTheme`. */
const pc: typeof base = { ...base };
export default pc;

let current: ThemeName = "default";

function truecolor(hex: string): (input: unknown) => string {
  const n = parseInt(hex.slice(1), 16);
  const open = `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
  // Re-open after every inner close, so `cyan("a" + red("b") + "c")` keeps `c` cyan.
  return (input) => open + String(input).split(CLOSE).join(CLOSE + open) + CLOSE;
}

function isThemeName(name: string): name is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(name);
}

function apply(name: ThemeName): void {
  for (const key of COLOR_KEYS) {
    pc[key] = name === "default" || !base.isColorSupported ? base[key] : truecolor(THEMES[name][key]);
  }
  current = name;
}

export function getTheme(): ThemeName {
  return current;
}

/** Style the composer without changing the terminal's surrounding background. */
export function stylePrompt(line: string): string {
  if (current !== "retrowave" || !base.isColorSupported) return line;
  const foreground = "\x1b[38;2;224;222;244m";
  const background = "\x1b[48;2;22;22;30m";
  const styled = line.replace(/\x1b\[(?:0|39|49)?m/g, (reset) => reset + foreground + background);
  return foreground + background + styled + "\x1b[39m\x1b[49m";
}

/**
 * Switch to `name` (case-insensitive). Returns false, changing nothing, for an
 * unknown name. With a `configDir`, the choice is saved there; a failed save
 * throws after the theme is applied, so the caller can say it will not survive
 * a restart. `null` applies without saving.
 */
export function setTheme(name: string, configDir: string | null): boolean {
  const key = name.trim().toLowerCase();
  if (!isThemeName(key)) return false;
  apply(key);
  if (configDir !== null) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, THEME_FILE), key + "\n");
  }
  return true;
}

/**
 * Apply the theme saved in `configDir` and return its name. No file means
 * `default`. An unreadable file or an unknown name also means `default`, with a
 * warning on stderr so the user knows why their choice did not come back.
 */
export function loadSavedTheme(configDir: string): ThemeName {
  const path = join(configDir, THEME_FILE);
  if (!existsSync(path)) {
    apply("default");
    return current;
  }
  let saved: string;
  try {
    saved = readFileSync(path, "utf-8").trim().toLowerCase();
  } catch (error) {
    console.error(base.yellow(`⚠ could not read the saved theme (${path}): ${(error as Error).message}`));
    apply("default");
    return current;
  }
  if (!isThemeName(saved)) {
    console.error(base.yellow(`⚠ unknown saved theme "${saved}" in ${path} — using default`));
    apply("default");
    return current;
  }
  apply(saved);
  return current;
}
