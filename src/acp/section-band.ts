/**
 * Section band — the coloured strip that marks one section of the transcript.
 *
 * Pi's TUI paints every section of a conversation with its own band: answers
 * and thoughts take the black one, tool calls the dark blue one, shell output
 * the teal one (green in monokai), the user's prompt the light mauve one.
 * rossii has no equivalent primitive, so this
 * component paints a child's rendered lines: a one-column blank gutter plus a
 * background that spans the transcript width.
 *
 * It is a wrapper rather than a change to each component so the layout stays
 * untouched — the child still renders at `width - 1`, and the wrapper only
 * decorates what came back.
 */

import { visibleWidth, type Component } from "@earendil-works/pi-tui";

import pc, { bandBackground, themeChrome } from "../theme";

/**
 * The gutter is a blank column, not a glyph: the section is identified by its
 * background, so a bar would only add noise to a line the user may copy.
 */
export const AGENT_BAND_GUTTER = " ";
export const BLACK_BAND_GUTTER = " ";
export const TOOL_BAND_GUTTER = " ";
export const USER_BAND_GUTTER = " ";

/**
 * The colours live in `themeChrome()` (`../theme.ts`), never here: each theme
 * brings its own bands at the same lightness, so contrast does not depend on
 * which theme is active. These four functions read the chrome at *render* time,
 * so `/theme` takes effect on the next block without a restart.
 *
 * The fallbacks are what a test sees when it builds a band outside any themed
 * chrome — the retrowave values, so the assertions stay meaningful.
 */
export function agentBandBg(): string {
  return bandBackground(themeChrome()?.agentBand ?? "12;12;14");
}

/** Shell band: the rawest output on screen. */
export function shellBandBg(): string {
  return bandBackground(themeChrome()?.shellBand ?? "0;129;176");
}

/**
 * Foreground of the shell band, when the theme gives it a mid-tone background:
 * the retrowave teal is light enough that the inherited colours lose their
 * contrast on it, so those themes name a white one. Absent leaves the text as
 * the block rendered it, which is right for a dark band.
 */
export function shellBandFg(): string | undefined {
  const fg = themeChrome()?.shellBandFg;
  return fg ? `\x1b[38;2;${fg}m` : undefined;
}

/** Tool band: a tool call must never read as an answer. */
export function toolBandBg(): string {
  return bandBackground(themeChrome()?.toolBand ?? "18;42;58");
}

/**
 * User band: the one light background in the transcript, so it needs its own
 * foreground. Background and foreground come from the same entry, so the pair
 * cannot drift apart.
 */
export function userBandBg(): string {
  return bandBackground(themeChrome()?.userBand ?? "200;156;255");
}

export function userBandFg(): string {
  return `\x1b[38;2;${themeChrome()?.userBandFg ?? "26;16;36"}m`;
}

/** Whether the current theme paints bands at all. */
export function bandsEnabled(): boolean {
  return themeChrome() !== null && pc.isColorSupported;
}

/**
 * Paint `lines` as one band: `gutter` in the first column, `background` over
 * every column. Each line ends with `\x1b[49m`, and any reset inside a line
 * re-opens the background so a coloured span cannot punch a hole in the band.
 */
export function bandLines(
  lines: readonly string[],
  width: number,
  background: string,
  gutter: string,
  foreground?: string,
): string[] {
  return lines.map((line) => {
    const content = gutter + line;
    const padded = content + " ".repeat(Math.max(0, width - visibleWidth(content)));
    // A light band needs its own foreground: every reset inside the line would
    // otherwise drop back to the transcript's near-white, which is unreadable on
    // it. Without a foreground the behaviour is unchanged.
    if (!foreground) {
      return background + padded.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + background) + "\x1b[49m";
    }
    const painted = padded.replace(/\x1b\[(?:0|39|49)?m/g, (reset) => reset + foreground + background);
    return foreground + background + painted + "\x1b[39m\x1b[49m";
  });
}

/**
 * A child rendered inside a band. Under a theme with no chrome this is a
 * pass-through, so the transcript keeps its plain look.
 */
export class SectionBand implements Component {
  private readonly child: Component;
  private readonly background: string;
  private readonly gutter: string;

  constructor(
    child: Component,
    background: string = agentBandBg(),
    gutter: string = AGENT_BAND_GUTTER,
  ) {
    this.child = child;
    this.background = background;
    this.gutter = gutter;
  }

  /** The wrapped component (tests and the chat use it to reach the block). */
  get inner(): Component {
    return this.child;
  }

  render(width: number): string[] {
    if (!bandsEnabled()) return this.child.render(width);
    const innerWidth = Math.max(1, width - 1);
    const fg = themeChrome()?.agentBandFg;
    return bandLines(
      this.child.render(innerWidth),
      width,
      this.background,
      this.gutter,
      fg ? `\x1b[38;2;${fg}m` : undefined,
    );
  }

  invalidate(): void {
    this.child.invalidate();
  }
}
