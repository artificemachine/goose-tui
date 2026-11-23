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
  retrowave: { red: "#F7768E", green: "#73DACA", yellow: "#FF9E64", blue: "#7DCFFF", magenta: "#BB9AF7", cyan: "#00E5FF" },
  // Retrowave, but the six colours come from published synthwave charts instead
  // of taste: Outrunner 16 (red, blue, cyan), Pixelwave (yellow) and Neon Pulse 8
  // (magenta). Same chrome as `retrowave`, its own composer surface below.
  retrowave2: { red: "#FF4764", green: "#73DACA", yellow: "#FFD156", blue: "#008BF5", magenta: "#DF35C1", cyan: "#47EDFF" },
  // Monokai. Six slots for a seven-colour palette: `blue` and `cyan` must differ
  // or a terminal cannot tell an info line from an accent, so `cyan` — the accent
  // used for borders and hints — takes Monokai's orange `#FD971F`, and `blue`
  // keeps the signature `#66D9EF`. Everything else is the original value.
  monokai: { red: "#F92672", green: "#A6E22E", yellow: "#E6DB74", blue: "#66D9EF", magenta: "#AE81FF", cyan: "#FD971F" },
  dracula: { red: "#FF5555", green: "#50FA7B", yellow: "#F1FA8C", blue: "#BD93F9", magenta: "#FF79C6", cyan: "#8BE9FD" },
  nord: { red: "#BF616A", green: "#A3BE8C", yellow: "#EBCB8B", blue: "#81A1C1", magenta: "#B48EAD", cyan: "#88C0D0" },
  // For light terminal backgrounds.
  light: { red: "#B3263E", green: "#1F7A6D", yellow: "#A8691A", blue: "#0550AE", magenta: "#8250DF", cyan: "#1B7C83" },
} as const satisfies Record<string, Palette>;

export type ThemeName = "default" | keyof typeof THEMES;

export const THEME_NAMES: readonly ThemeName[] = ["default", ...(Object.keys(THEMES) as (keyof typeof THEMES)[])];

/**
 * Themes that paint rossii's own chrome on top of the six colours: the section
 * bands, the composer surface, the status bar and the conversation frame. The
 * palette alone cannot express those, so `themeChrome()` is the single source
 * for every one of them — a theme is in this table or it has no chrome at all.
 *
 * The rule for a new entry is one slot per section, never a per-theme
 * arrangement: answers sit on the darkest band (near-black to a dark slate),
 * tool calls on a visibly blue one above it, shell output on the coloured one
 * above that, the user's own message on the one light (mauve) band, and the
 * composer stays a dark surface of its own. Only the hue changes between
 * themes, so a section keeps its rank and its meaning when the theme changes —
 * `tests/theme.test.ts` measures each slot's lightness, hue family and contrast
 * and fails the build when an entry moves a section to another surface.
 */
export interface ThemeChrome {
  /** Section bands, as `"r;g;b"` for a 24-bit SGR sequence. */
  agentBand: string;
  /**
   * Text colour for a *light* agent band; absent means "leave the text alone",
   * which is right for a dark band. Present means the band needs a dark
   * foreground, the same rule as `userBandFg`.
   */
  agentBandFg?: string;
  userBand: string;
  /** Text colour for the user band — it is the light one. */
  userBandFg: string;
  toolBand: string;
  shellBand: string;
  /**
   * Text colour for the shell band. A mid-tone band needs its own foreground,
   * the same rule as `userBandFg`; absent means "leave the text alone", which
   * is right for a dark band.
   */
  shellBandFg?: string;
  /** Composer surface (`stylePrompt`). */
  promptFg: string;
  promptBg: string;
  /**
   * Text colour of the status strip. The strip paints no background of its own
   * — the terminal's shows through, the way a HUD floats over the desktop — and
   * its chips are the neutral greys of `STATUS_CHIPS`, so this is the only
   * colour a theme brings to the bar.
   */
  statusFg: string;
}

const CHROME: Record<string, ThemeChrome> = {
  // The reference, with the owner's swap: answers sit on the quiet band and shell
  // output takes the coloured one, so the prose is the calm part of the screen
  // and the command output is the loud part. The answer band is the owner's
  // slate `#323240` (L* 21.3) — a dark grey with a faint blue cast — the shell
  // band the retrowave teal `#0081B0` (L* 50.5, the lightest, so it carries its
  // own white foreground: the theme's green reads 2.7:1 on it), and the tool
  // band the blue `#204F65` (L* 31.4), ten L* above the answers so a tool call
  // never reads as an answer. The user's own message keeps the light mauve
  // band. Every other chrome theme reproduces those slots and only changes the
  // hues.
  retrowave: {
    agentBand: "50;50;64",
    userBand: "200;156;255",
    userBandFg: "26;16;36",
    toolBand: "32;79;101",
    shellBand: "0;129;176",
    shellBandFg: "255;255;255",
    promptFg: "224;222;244",
    promptBg: "22;22;30",
    statusFg: "224;222;244",
  },
  // Same structure and same slots, its own composer surface: Neon Pulse 8's
  // deep violet.
  retrowave2: {
    agentBand: "50;50;64",
    userBand: "200;156;255",
    userBandFg: "26;16;36",
    toolBand: "32;79;101",
    shellBand: "0;129;176",
    shellBandFg: "255;255;255",
    promptFg: "232;226;255",
    promptBg: "26;15;46",
    statusFg: "232;226;255",
  },
  // Monokai on the retrowave slots: same roles, same lightness, its own hues.
  // The answers keep the black band — Monokai's warm black rather than
  // retrowave's cool one — and the shell keeps the green one, in Monokai's lime
  // `#A6E22E` darkened and turned a little toward green so it still reads as
  // *green* at that lightness (`#A6E22E` alone darkens to an olive). The role
  // wins over the palette slot, so neither the pink `#F92672` nor a neutral grey
  // stands in for a band retrowave gives a colour. The user band is `#AE81FF`
  // lightened to the mauve that band needs, the tool band `#66D9EF` darkened,
  // and the composer stays a step above the black band. Its status strip
  // is Monokai's translucent black `#00000061`: SGR has no alpha and rossii
  // cannot know what is behind the bar, so the strip paints no background and
  // its chips keep the neutral greys the bar has in every theme.
  monokai: {
    agentBand: "12;12;10",
    userBand: "192;159;255",
    userBandFg: "26;21;38",
    toolBand: "14;44;50",
    shellBand: "42;72;21",
    promptFg: "248;248;242",
    promptBg: "24;24;20",
    statusFg: "248;248;242",
  },
};

/** The chrome of the current theme, or null when it paints none. */
export function themeChrome(): ThemeChrome | null {
  return CHROME[current] ?? null;
}

/** Build a 24-bit SGR pair from a `"r;g;b"` triple. */
export function bandBackground(rgb: string): string {
  return `\x1b[48;2;${rgb}m`;
}

/** The same for a foreground. */
export function bandForeground(rgb: string): string {
  return `\x1b[38;2;${rgb}m`;
}

// ─── The status bar's chips ──────────────────────────────────────────────────

/**
 * The status strip is a HUD, not a band: no background of its own, a row of
 * slanted chips, and the terminal showing through between them. The chip colours
 * are the reference HUD's own greys — neutral, in the same order, so the bar
 * looks the same in every theme and only the *text* takes the theme's colour.
 *
 * The third step is `#626262` where the reference uses `#707070`: at L* 47 a
 * theme's near-white text reads at 3.8:1, under WCAG AA, and the step is one
 * shade darker to reach 4.6:1. Everything else is the reference's own grey.
 */
export const STATUS_CHIPS: readonly string[] = ["48;48;48", "85;85;85", "98;98;98", "65;65;65"];

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
  const chrome = themeChrome();
  if (!chrome || !base.isColorSupported) return line;
  const foreground = bandForeground(chrome.promptFg);
  const background = bandBackground(chrome.promptBg);
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
