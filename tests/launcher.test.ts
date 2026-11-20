/**
 * The `bin/goose-tui` launcher and the names that stay `rossii`: the tests
 * `docs/specs/SPEC-005-launcher-and-name.md` binds to.
 *
 * The launcher runs against a throwaway checkout whose entry point only echoes
 * its arguments, so no chat is started. Usage: bun test tests/
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { newSessionMeta } from "../src/acp/session-meta";
import { journalDir } from "../src/journal";

const LAUNCHER = resolve(import.meta.dir, "..", "bin", "goose-tui");

let dir = "";

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "goose-tui-launcher-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A checkout holding a copy of the launcher and an entry that echoes its arguments. */
function fakeCheckout(name: string): string {
  const root = join(dir, name);
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  copyFileSync(LAUNCHER, join(root, "bin", "goose-tui"));
  writeFileSync(join(root, "src", "index.ts"), `console.log(JSON.stringify({ root: ${JSON.stringify(name)}, args: process.argv.slice(2) }));\n`);
  return root;
}

function run(command: string, args: string[], env: Record<string, string> = {}) {
  const inherited = { ...process.env };
  delete inherited.GOOSE_TUI_ROOT;
  return spawnSync("bash", [command, ...args], { cwd: dir, encoding: "utf8", env: { ...inherited, ...env } });
}

test("launcher_runs_from_anywhere_through_a_symlink", () => {
  fakeCheckout("checkout");
  mkdirSync(join(dir, "links", "deep"), { recursive: true });
  // A relative link, then an absolute link to that link: both are followed.
  symlinkSync(join("..", "checkout", "bin", "goose-tui"), join(dir, "links", "goose-tui"));
  symlinkSync(join(dir, "links", "goose-tui"), join(dir, "links", "deep", "goose-tui"));

  for (const link of [join(dir, "links", "goose-tui"), join(dir, "links", "deep", "goose-tui")]) {
    const result = run(link, ["doctor", "--flag", "two words"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ root: "checkout", args: ["doctor", "--flag", "two words"] });
  }
});

test("launcher_root_can_be_overridden", () => {
  fakeCheckout("checkout");
  const other = fakeCheckout("other");
  const result = run(join(dir, "checkout", "bin", "goose-tui"), [], { GOOSE_TUI_ROOT: other });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ root: "other", args: [] });
});

test("launcher_refuses_a_root_without_an_entry_point", () => {
  const empty = join(dir, "empty");
  mkdirSync(empty);
  const result = run(LAUNCHER, ["doctor"], { GOOSE_TUI_ROOT: empty });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`goose-tui: no src/index.ts under ${empty}`);
});

test("identifiers_stay_rossii", () => {
  // The client name goose stores with every session.
  expect(newSessionMeta({}).client).toBe("rossii");

  // The state directory keeps the upstream name and its environment variable.
  const saved = { state: process.env.ROSSII_STATE_DIR, xdg: process.env.XDG_STATE_HOME };
  try {
    delete process.env.ROSSII_STATE_DIR;
    process.env.XDG_STATE_HOME = join(dir, "state");
    expect(journalDir()).toBe(join(dir, "state", "rossii"));
    process.env.ROSSII_STATE_DIR = join(dir, "elsewhere");
    expect(journalDir()).toBe(join(dir, "elsewhere"));
  } finally {
    if (saved.state === undefined) delete process.env.ROSSII_STATE_DIR;
    else process.env.ROSSII_STATE_DIR = saved.state;
    if (saved.xdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved.xdg;
  }
});
