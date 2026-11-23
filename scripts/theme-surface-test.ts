#!/usr/bin/env bun
import assert from "node:assert/strict";
import { Container, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";

process.env.FORCE_COLOR = "1";
delete process.env.NO_COLOR;
const { setTheme, stylePrompt } = await import("../src/theme");
const { PromptEditor, RecapSurface, conversationView, StatusSurface } = await import("../src/acp/chat-ui");
const { SectionBand } = await import("../src/acp/section-band");
const { editorTheme, userMessageLine } = await import("../src/acp/chat-context");
const { ToolCallBlock } = await import("../src/acp/tool-call-block");
// SAFETY: Editor rendering and input use only terminal.rows and requestRender in this fixture.
const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;
const editor = new PromptEditor(tui, editorTheme, { paddingX: 1 });
editor.focused = true;
editor.setText("hello");
setTheme("default", null);
const original = editor.render(30);
assert.ok(!original.join("").includes("\x1b[48;2;22;22;30m"));
assert.equal(setTheme("retrowave", null), true);
const styled = editor.render(30);
assert.ok(styled.join("").includes("\x1b[48;2;22;22;30m"), "prompt background");
assert.ok(styled[0].includes("\x1b[38;2;0;229;255m"), "prompt border (retrowave cyan)");
assert.ok(styled[0].includes("─") && !styled[0].includes("╭"), "prompt top border is a rule, not a corner");
assert.ok(!styled[1].includes("│"), "prompt has no side bars");
assert.ok(styled[2].includes("─") && !styled[2].includes("╰"), "prompt bottom border is a rule, not a corner");
assert.ok(styled.slice(1, -1).every((line) => !line.includes("│")), "no vertical bar anywhere in the composer");
assert.ok(stylePrompt("x\x1b[0my").includes("\x1b[0m\x1b[38;2;224;222;244m\x1b[48;2;22;22;30my"), "restore colors after reset");
assert.ok(stylePrompt("x").endsWith("\x1b[39m\x1b[49m"), "no color leaks after prompt");
assert.equal(editor.focused, true);
editor.handleInput("!");
assert.equal(editor.getText(), "hello!");
assert.ok(editor.render(1).length >= 3, "narrow render");
for (const width of [3, 4, 8, 30]) {
  assert.ok(editor.render(width).every((line) => visibleWidth(line) <= width), `prompt fits width ${width}`);
}
const document = new Container();
document.addChild(new Text("conversation", 0, 0));
// The conversation surface has no frame: no rounded corners, no side bars —
// the section bands close each block and the composer draws its own rules.
const view = conversationView(document);
const transcript = view.render(30).join("\n");
assert.ok(transcript.includes("conversation"), "the transcript renders its text");
assert.ok(!transcript.includes("╭") && !transcript.includes("╰"), "no rounded frame around the conversation");
assert.ok(!transcript.includes("╮") && !transcript.includes("╯"), "no rounded frame corners on the right");
assert.ok(!view.render(30).some((line) => line.includes("│")), "no side borders around the conversation");
// The status bar is pi-bar's powerline strip: chips with a leading \ue0ba and a
// trailing \ue0bc cut out of the terminal's own background, so the bar itself
// paints no background at all.
const segments = () => [{ kind: "model" as const, label: "provider/model" }, { kind: "usage" as const, label: "9% of 500k" }];
const status = new StatusSurface(segments).render(60)[0];
assert.ok(status.includes("\ue0ba") && status.includes("\ue0bc"), "status chips use the powerline separators");
assert.ok(status.includes("\x1b[48;2;48;48;48m"), "the first chip is the reference grey");
assert.ok(status.includes("\x1b[38;2;224;222;244m"), "chip text takes the status foreground");
assert.ok(!status.includes("\x1b[48;2;52;42;72m"), "the bar no longer paints a band of its own");
assert.ok(!status.includes("\x1b[2m"), "status is not dimmed");
assert.ok(visibleWidth(status) <= 60, "the strip fits the width");
assert.equal(visibleWidth(status), " provider/model ".length + " 9% of 500k ".length + 4, "two chips, two separators each");
// The recap line above the composer: pi-recap's widget, muted, wrapped on
// spaces, capped at two rows — a paragraph above the composer is not a glance.
const { RECAP_HINT: RECAP_HINT_TEXT, RECAP_MAX_ROWS, buildRecapLine } = await import("../src/acp/recap");
const recapText = buildRecapLine(
  "※ recap: Loaded project handoff; found one untracked evaluation plan and no ICM memories. Next, continue with the handoff's recommended autonomy-plan work.",
);
const recapRows = new RecapSurface(() => recapText).render(60);
assert.equal(recapRows.length, RECAP_MAX_ROWS, "a long recap takes the two rows it is allowed");
assert.ok(recapRows.every((row) => visibleWidth(row) <= 60), "recap rows fit the width");
// Each row carries one column of padding and its own SGR pair, so drop the
// colour and rejoin on whitespace runs before reading the text back.
const recapFlat = recapRows.join(" ").replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ");
assert.ok(recapFlat.includes("…"), "a cut recap shows where it stopped");
assert.ok(recapFlat.includes(RECAP_HINT_TEXT), "the recap names the way out, even when cut");
const wideRows = new RecapSurface(() => buildRecapLine(recapText)).render(120);
const wideFlat = wideRows.join(" ").replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ");
assert.ok(wideFlat.includes("autonomy-plan work"), "at 120 columns the next action survives whole");
assert.ok(wideRows.length <= RECAP_MAX_ROWS, "and still in two rows");
assert.ok(recapRows.every((row) => row.includes("\x1b[2m")), "the recap is muted");
assert.deepEqual(new RecapSurface(() => null).render(60), [""], "no recap means one empty row");
assert.equal(new RecapSurface(() => null).render(60)[0], "", "the composer does not jump when a recap arrives");

// A narrow width drops the chips that no longer fit rather than overflowing.
const narrow = new StatusSurface(segments).render(20)[0];
assert.ok(visibleWidth(narrow) <= 20, "narrow status fits the width");
const userMessage = userMessageLine("❯ Hello\nsecond line");
const userLines = userMessage.render(30);
assert.ok(userLines.length >= 2, "multiline user message");
assert.ok(userLines.every((line) => line.includes("\x1b[48;2;200;156;255m")), "every user message line takes the mauve band");
assert.ok(userLines.every((line) => line.includes("\x1b[38;2;26;16;36m")), "the mauve band carries its dark foreground");
assert.ok(userLines.every((line) => !line.includes("\x1b[48;2;12;12;14m")), "a user message is not the answers' black band");
assert.ok(userLines.every((line) => visibleWidth(line) === 30), "user message background spans the width");
const tool = new ToolCallBlock();
tool.setTitle("shell · echo hello");
assert.ok(tool.render(30).every((line) => line.includes("\x1b[48;2;0;129;176m")), "shell takes the retrowave teal band");
assert.ok(tool.render(30).every((line) => line.includes("\x1b[38;2;255;255;255m")), "the teal band carries its white foreground");
assert.ok(!tool.render(30)[0].includes("\u258c"), "no gutter glyph on a shell block");
tool.setTitle("read · file.txt");
assert.ok(tool.render(30).every((line) => line.includes("\x1b[48;2;18;42;58m")), "tool calls take the blue band");
assert.ok(!tool.render(30)[0].includes("\u258c"), "no gutter glyph on a tool call");
tool.setKind("execute");
tool.setKind(undefined);
assert.ok(tool.render(30)[0].includes("\x1b[48;2;0;129;176m"), "ACP kind survives partial updates and takes precedence over title");
tool.setTitle("shell · echo hello");
tool.setKind("other");
assert.ok(tool.render(30)[0].includes("\x1b[48;2;0;129;176m"), "default ACP kind falls back to title");
tool.setTitle("load skill · x");
assert.ok(tool.render(30)[0].includes("\x1b[48;2;18;42;58m"), "non-shell tools share the blue band");
const banded = new SectionBand(new Text("answer line\nsecond", 1, 0)).render(30);
assert.equal(banded.length, 2, "band keeps the child's line count");
assert.ok(banded.every((line) => line.includes("\x1b[48;2;12;12;14m")), "answer sections carry the black band");
assert.ok(banded.every((line) => !line.includes("\u258c")), "answer sections carry no gutter glyph");
assert.ok(banded.every((line) => visibleWidth(line) === 30), "the band spans the width");
// Monokai: the retrowave slots with Monokai's own hues — warm black answers,
// mauve user band, lime-green shell, blue tools. Same sections, same ranking as
// retrowave: the palette slot never decides a role, and no neutral grey stands
// in for a band retrowave gives a colour.
assert.equal(setTheme("monokai", null), true);
assert.ok(editor.render(30).join("").includes("\x1b[48;2;24;24;20m"), "monokai composer surface");
assert.ok(editor.render(30).join("").includes("\x1b[38;2;248;248;242m"), "monokai composer foreground");
const monokaiUser = userMessageLine("❯ hello").render(30);
assert.ok(monokaiUser.every((line) => line.includes("\x1b[48;2;192;159;255m")), "monokai user band is mauve");
assert.ok(monokaiUser.every((line) => line.includes("\x1b[38;2;26;21;38m")), "monokai user band carries its dark foreground");
assert.ok(monokaiUser.every((line) => !line.includes("\x1b[48;2;200;156;255m")), "monokai does not borrow retrowave's exact mauve");
const monokaiStatus = new StatusSurface(segments).render(60)[0];
assert.ok(monokaiStatus.includes("\x1b[48;2;48;48;48m"), "monokai uses the same neutral chips");
assert.ok(monokaiStatus.includes("\x1b[38;2;248;248;242m"), "monokai chip text keeps Monokai's white");
assert.ok(monokaiStatus.includes("\ue0ba") && monokaiStatus.includes("\ue0bc"), "monokai chips are powerline chips too");
const monokaiAnswer = new SectionBand(new Text("answer", 1, 0)).render(30);
assert.ok(monokaiAnswer.every((line) => line.includes("\x1b[48;2;12;12;10m")), "monokai answers take its warm black band");
assert.ok(monokaiAnswer.every((line) => !line.includes("\x1b[48;2;249;38;114m")), "monokai answers never take its pink");
assert.ok(monokaiAnswer.every((line) => !line.includes("\x1b[48;2;64;64;64m")), "monokai answers never take a neutral grey");
tool.setKind("read");
assert.ok(tool.render(30).every((line) => line.includes("\x1b[48;2;14;44;50m")), "monokai tools take its blue band");
tool.setKind("execute");
assert.ok(tool.render(30).every((line) => line.includes("\x1b[48;2;42;72;21m")), "monokai shell takes its green band");
// A band is painted from the theme active when it is built; the render-time
// surfaces (composer, status, an already-built tool block) follow a switch.
setTheme("retrowave", null);
const backToRetrowave = new SectionBand(new Text("answer", 1, 0)).render(30);
assert.ok(backToRetrowave.every((line) => line.includes("\x1b[48;2;12;12;14m")), "switching back restores the retrowave answer band");
setTheme("default", null);
assert.ok(!view.render(30).join("").includes("╭"), "default has no frame");
tool.setKind("read");
assert.ok(!tool.render(30).join("").includes("\x1b[48;2;18;42;58m"), "a theme with no chrome paints no bands");
assert.ok(tool.render(30).every((line) => visibleWidth(line) <= 30), "tool block fits the width");
assert.deepEqual(editor.render(30).length, original.length);
assert.ok(!editor.render(30).join("").includes("\x1b[48;2;22;22;30m"));
console.log("✅ prompt surface and live switching");
