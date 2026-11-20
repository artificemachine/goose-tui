/**
 * Section band — the coloured strip that marks one section of the transcript.
 *
 * Pi's TUI paints every section of a conversation with its own band: agent
 * sections (answers, thoughts, tool calls) share the green one, the user's
 * prompt gets the black one. rossii has no equivalent primitive, so this
 * component paints a child's rendered lines: a one-column gutter in the accent
 * colour plus a background that spans the transcript width.
 *
 * It is a wrapper rather than a change to each component so the layout stays
 * untouched — the child still renders at `width - 1`, and the wrapper only
 * decorates what came back.
 */

import { visibleWidth, type Component } from "@earendil-works/pi-tui";

import pc, { getTheme } from "../theme";

/** Green band: agent content (answers, thoughts, tool calls that are not shell). */
export const AGENT_BAND_BG = "\x1b[48;2;24;72;52m";
export const AGENT_BAND_GUTTER = "\x1b[38;2;115;218;202m\u258c\x1b[39m";

/** Black band: what the user typed, and the shell. */
export const BLACK_BAND_BG = "\x1b[48;2;12;12;14m";
export const BLACK_BAND_GUTTER = "\x1b[38;2;150;150;158m\u258c\x1b[39m";

/** Blue band: tool calls, so a tool section never reads as an answer. */
export const TOOL_BAND_BG = "\x1b[48;2;18;42;58m";
export const TOOL_BAND_GUTTER = "\x1b[38;2;125;207;255m\u258c\x1b[39m";

/** Whether the current theme paints bands at all. */
export function bandsEnabled(): boolean {
  return getTheme() === "retrowave" && pc.isColorSupported;
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
): string[] {
  return lines.map((line) => {
    const content = gutter + line;
    const padded = content + " ".repeat(Math.max(0, width - visibleWidth(content)));
    return background + padded.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + background) + "\x1b[49m";
  });
}

/**
 * A child rendered inside a band. Under any other theme this is a pass-through,
 * so the transcript keeps its plain look outside `retrowave`.
 */
export class SectionBand implements Component {
  private readonly child: Component;
  private readonly background: string;
  private readonly gutter: string;

  constructor(
    child: Component,
    background: string = AGENT_BAND_BG,
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
    return bandLines(this.child.render(innerWidth), width, this.background, this.gutter);
  }

  invalidate(): void {
    this.child.invalidate();
  }
}
