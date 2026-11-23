/**
 * The rendered surfaces, as a bun test so a requirement can bind to them.
 *
 * `scripts/theme-surface-test.ts` renders every theme at once and stays the
 * wider check; this file carries what SPEC-002's REQ-019 claims — the
 * conversation has no frame — plus the recap line's two-row contract, because
 * a bound requirement needs a named test and a script has no test names.
 */

import { describe, expect, test } from "bun:test";

import { Container, Text } from "@earendil-works/pi-tui";

import { RecapSurface, conversationView } from "../src/acp/chat-ui";
import { renderStatus } from "../src/acp/chat-stream";
import { projectNameFromCwd } from "../src/utils";
import { formatBranch } from "../src/worktree";
import { RECAP_HINT, RECAP_MAX_ROWS, buildRecapLine } from "../src/acp/recap";

const plain = (rows: string[]) =>
  rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

function transcript(): Container {
  const document = new Container();
  document.addChild(new Text("the conversation", 1, 0));
  return document;
}

describe("the conversation surface", () => {
  test("the_conversation_renders_without_a_frame", () => {
    const rows = conversationView(transcript()).render(30);
    expect(rows.join("\n")).toContain("the conversation");
    expect(rows.join("")).not.toContain("╭");
    expect(rows.join("")).not.toContain("╮");
    expect(rows.join("")).not.toContain("╰");
    expect(rows.join("")).not.toContain("╯");
    rows.forEach((row) => expect(row).not.toContain("│"));
  });
});

describe("the recap line surface", () => {
  const line = buildRecapLine(
    "※ recap: Loaded project handoff; one untracked plan and no ICM memories. Next, continue with the autonomy-plan work.",
  );

  test("the_recap_takes_at_most_two_rows_and_shows_where_it_stopped", () => {
    const rows = new RecapSurface(() => line).render(40);
    expect(rows.length).toBeLessThanOrEqual(RECAP_MAX_ROWS);
    const text = plain(rows).replace(/\s+/g, " ");
    expect(text).toContain("…");
    expect(text).toContain(RECAP_HINT);
  });

  test("every_recap_row_fits_the_width_with_its_padding", () => {
    // The muted styling itself is pinned in `scripts/theme-surface-test.ts`:
    // picocolors switches colour off when stdout is not a TTY, which is what
    // `bun test` is, so an SGR assertion here would only test the terminal.
    const rows = new RecapSurface(() => line).render(100);
    rows.forEach((row) => {
      expect(row.startsWith(" ")).toBe(true);
      expect([...row].length).toBeLessThanOrEqual(100);
    });
    expect(plain(rows).replace(/\s+/g, " ")).toContain(RECAP_HINT);
  });

  test("no_recap_is_one_empty_row", () => {
    expect(new RecapSurface(() => null).render(80)).toEqual([""]);
  });
});

describe("the status line", () => {
  const ctxOf = (overrides: Record<string, unknown> = {}) =>
    ({
      projectName: "goose-tui",
      projectBranch: "feat/darwin-release-assets",
      currentProvider: "custom_deepseek",
      currentModel: "deepseek-flash",
      currentSetLabel: "Default",
      statusSegments: [],
      tui: { requestRender() {} },
      ...overrides,
    }) as any;

  test("the_project_comes_first", () => {
    const ctx = ctxOf();
    renderStatus(ctx);
    expect(ctx.statusSegments[0]).toEqual({ kind: "project", label: "goose-tui" });
    expect(ctx.statusSegments.map((s: any) => s.kind)).toEqual(["project", "branch", "model", "set"]);
  });

  test("the model chip names the model alone, the provider stays in the header", () => {
    const ctx = ctxOf();
    renderStatus(ctx);
    const model = ctx.statusSegments.find((s: any) => s.kind === "model");
    expect(model).toEqual({ kind: "model", label: "deepseek-flash" });
    expect(model.label).not.toContain("custom_deepseek");
  });

  test("the branch follows the project, and is absent outside a repository", () => {
    const inRepo = ctxOf();
    renderStatus(inRepo);
    expect(inRepo.statusSegments[1]).toEqual({ kind: "branch", label: "feat/darwin-release-assets" });

    const noRepo = ctxOf({ projectBranch: null });
    renderStatus(noRepo);
    expect(noRepo.statusSegments.map((s: any) => s.kind)).toEqual(["project", "model", "set"]);
  });

  test("a long branch is elided in the middle, so both ends stay readable", () => {
    const long = "feature/very-long-branch-name-that-would-eat-the-bar";
    const shown = formatBranch(long);
    expect(shown.length).toBeLessThanOrEqual(32);
    expect(shown.startsWith("feature/")).toBe(true);
    expect(shown.endsWith("the-bar")).toBe(true);
    expect(shown).toContain("…");
    expect(formatBranch("main")).toBe("main");
  });

  test("the project name follows the working directory, worktrees included", () => {
    expect(projectNameFromCwd("/Users/me/code/goose-tui")).toBe("goose-tui");
    expect(projectNameFromCwd("/Users/me/code/goose-tui/")).toBe("goose-tui");
    // A worktree is the same project, not a project called `feat-x`.
    expect(projectNameFromCwd("/Users/me/code/goose-tui/.worktree/feat-x")).toBe("goose-tui");
    expect(projectNameFromCwd("/")).toBe("?");
  });
});
