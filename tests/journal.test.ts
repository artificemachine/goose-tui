/**
 * The error journal (`src/journal.ts`): the tests `INVARIANTS.md` and
 * `docs/specs/SPEC-001-project-foundation.md` bind to.
 *
 * Every test works in its own throwaway state directory, so nothing touches
 * the real one. Usage: bun test tests/
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { journalError, redactSecrets } from "../src/journal";
import { WebEngine, type EngineClient } from "../src/web/engine";
import type { WebEvent } from "../src/web/event";

let dir = "";
const savedStateDir = process.env.ROSSII_STATE_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "goose-tui-journal-"));
  process.env.ROSSII_STATE_DIR = dir;
});

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.ROSSII_STATE_DIR;
  else process.env.ROSSII_STATE_DIR = savedStateDir;
  rmSync(dir, { recursive: true, force: true });
});

const journalLines = (): Array<Record<string, unknown>> =>
  readFileSync(join(dir, "errors.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

const reports = (): Array<Record<string, unknown>> =>
  readdirSync(join(dir, "reports")).map((name) => JSON.parse(readFileSync(join(dir, "reports", name), "utf8")));

/** A client whose handshake works and whose turn always fails. */
const failingClient = (): EngineClient => ({
  initialize: async () => ({}),
  newSession: async () => ({ sessionId: "s1" }),
  prompt: async () => { throw new Error("provider returned 401"); },
  cancel: () => {},
  onUpdate: () => {},
  stop: () => {},
});

test("error_leaves_a_persistent_trace", async () => {
  journalError("fatal", new Error("boom"));
  const [entry] = journalLines();
  expect(entry!.scope).toBe("fatal");
  expect(entry!.message).toBe("boom");
  expect(Number.isNaN(Date.parse(String(entry!.ts)))).toBe(false);

  // A turn that fails is announced as an error, never as a finished turn, and
  // it reaches the journal with the explanation the client gave.
  const events: WebEvent[] = [];
  const engine = new WebEngine({ client: failingClient, emit: (event) => events.push(event) });
  await engine.start();
  await engine.prompt("hello");
  expect(events.some((event) => event.type === "done")).toBe(false);
  expect(events.some((event) => event.type === "error")).toBe(true);
  const turn = journalLines().find((line) => line.scope === "web.turn");
  expect(turn?.message).toBe("provider returned 401");
});

test("confirmed_failure_is_reported_once_and_queued", () => {
  journalError("chat.turn", new Error("turn timed out"));
  journalError("chat.turn", new Error("turn timed out"));
  journalError("chat.turn", new Error("agent exited"));

  expect(journalLines()).toHaveLength(3);
  const queued = reports();
  expect(queued).toHaveLength(2);
  const repeated = queued.find((report) => report.message === "turn timed out");
  expect(repeated?.count).toBe(2);
  expect(repeated?.label).toBe("AI-gen");
  // Publication is a later, separate act: the report waits in the queue.
  expect(repeated?.published).toBe(false);
});

test("secret_never_reaches_the_journal", () => {
  // Assembled at run time so no scanner mistakes this fixture for a real key.
  const secret = ["not", "a", "real", "secret", "value"].join("-");
  const env = { DEEPSEEK_API_KEY: secret, HOME: "/home/someone" };
  expect(redactSecrets(`401 for key ${secret}`, env)).toBe("401 for key [redacted:DEEPSEEK_API_KEY]");
  expect(redactSecrets("Authorization: Bearer abcdef0123456789", {})).toBe("Authorization: Bearer [redacted]");

  journalError("web.turn", new Error(`rejected key ${secret}`), { env });
  const written = readFileSync(join(dir, "errors.jsonl"), "utf8")
    + readdirSync(join(dir, "reports")).map((name) => readFileSync(join(dir, "reports", name), "utf8")).join("");
  expect(written.includes(secret)).toBe(false);
  expect(written.includes("[redacted:DEEPSEEK_API_KEY]")).toBe(true);
});

test("journal_files_are_owner_only", () => {
  journalError("fatal", new Error("boom"));
  const mode = (path: string) => statSync(path).mode & 0o777;
  expect(mode(dir)).toBe(0o700);
  expect(mode(join(dir, "errors.jsonl"))).toBe(0o600);
  expect(mode(join(dir, "reports"))).toBe(0o700);
  for (const name of readdirSync(join(dir, "reports"))) {
    expect(mode(join(dir, "reports", name))).toBe(0o600);
  }
});

test("journal_failure_never_throws", () => {
  // A state directory that sits under a regular file can never be created.
  writeFileSync(join(dir, "blocker"), "");
  process.env.ROSSII_STATE_DIR = join(dir, "blocker", "state");
  const original = process.stderr.write.bind(process.stderr);
  let announced = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    announced += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    expect(() => journalError("fatal", new Error("boom"))).not.toThrow();
  } finally {
    process.stderr.write = original;
  }
  // The failure to journal is itself reported, with the error it was carrying.
  expect(announced).toContain("error journal unavailable");
  expect(announced).toContain("boom");
});
