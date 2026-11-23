/**
 * herdr self-report (`src/herdr.ts`): the pane's dot must follow the session
 * and must never be able to break it.
 *
 * Usage: bun test tests/
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_AGENT_LABEL,
  NO_REPORTER,
  SOURCE_ID,
  TURN_STATE,
  buildArgs,
  isEnabled,
  makeReporter,
  type ReportState,
  type Spawner,
} from "../src/herdr";

/** A spawner that records its calls and never touches a real binary. */
function recorder(): { calls: Array<{ bin: string; args: string[] }>; spawner: Spawner } {
  const calls: Array<{ bin: string; args: string[] }> = [];
  return {
    calls,
    spawner: async (bin, args) => {
      calls.push({ bin, args });
    },
  };
}

const PANE_ENV = { HERDR_PANE_ID: "pane-7", HERDR_ENV: "1" } as NodeJS.ProcessEnv;

describe("the gate", () => {
  test("a herdr pane is required", () => {
    expect(isEnabled(PANE_ENV)).toBe(true);
    // herdr exports both; either one alone is not a pane.
    expect(isEnabled({ HERDR_PANE_ID: "pane-7" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isEnabled({ HERDR_ENV: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test("the switch turns it off", () => {
    expect(isEnabled({ ...PANE_ENV, ROSSII_HERDR_NO_SELF_REPORT: "1" })).toBe(false);
    // Any non-empty value disables, like the other ROSSI_* switches.
    expect(isEnabled({ ...PANE_ENV, ROSSII_HERDR_NO_SELF_REPORT: "yes" })).toBe(false);
  });
});

describe("the argv", () => {
  test("names the pane, the source, the agent, the state and a seq", () => {
    expect(buildArgs("pane-7", "goose-tui", "working", 42)).toEqual([
      "pane", "report-agent", "pane-7",
      "--source", SOURCE_ID,
      "--agent", "goose-tui",
      "--state", "working",
      "--seq", "42",
    ]);
    expect(SOURCE_ID).toBe("goose-tui");
  });

  test("carries a message only when one is given", () => {
    expect(buildArgs("p", "a", "blocked", 1)).not.toContain("--message");
    const withMessage = buildArgs("p", "a", "blocked", 1, "permission: write file");
    expect(withMessage.slice(-2)).toEqual(["--message", "permission: write file"]);
  });

  test("every state the chat uses is one herdr accepts", () => {
    const accepted: ReportState[] = ["idle", "working", "blocked", "unknown"];
    for (const state of Object.values(TURN_STATE)) expect(accepted).toContain(state);
  });
});

describe("the reporter", () => {
  let realEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    realEnv = process.env;
    process.env = { ...PANE_ENV };
  });

  afterEach(() => {
    process.env = realEnv;
  });

  test("does nothing outside a pane", () => {
    const { calls, spawner } = recorder();
    const reporter = makeReporter(spawner, {} as NodeJS.ProcessEnv);
    expect(reporter.enabled).toBe(false);
    reporter.report("working");
    expect(calls).toEqual([]);
  });

  test("spawns herdr with the state, and only on a change", () => {
    const { calls, spawner } = recorder();
    const reporter = makeReporter(spawner, PANE_ENV);
    expect(reporter.enabled).toBe(true);

    reporter.report("idle");
    reporter.report("idle"); // same state: dropped
    reporter.report("working");
    reporter.report("blocked");
    reporter.report("working");

    expect(calls.map((call) => call.args[call.args.indexOf("--state") + 1])).toEqual([
      "idle", "working", "blocked", "working",
    ]);
    for (const call of calls) {
      expect(call.bin).toBe("herdr");
      expect(call.args.slice(0, 3)).toEqual(["pane", "report-agent", "pane-7"]);
      expect(call.args[call.args.indexOf("--agent") + 1]).toBe(DEFAULT_AGENT_LABEL);
    }
  });

  test("the seq only ever grows, and starts from the clock", () => {
    const { calls, spawner } = recorder();
    const reporter = makeReporter(spawner, PANE_ENV);
    const before = Date.now();
    reporter.report("idle");
    reporter.report("working");
    reporter.report("idle");
    const seqs = calls.map((call) => Number(call.args[call.args.indexOf("--seq") + 1]));
    // A fresh low seq would look stale to herdr after a restart in the same pane.
    expect(seqs[0]).toBeGreaterThanOrEqual(before);
    expect(seqs[1]).toBeGreaterThan(seqs[0]!);
    expect(seqs[2]).toBeGreaterThan(seqs[1]!);
  });

  test("the agent label can be overridden", () => {
    const { calls, spawner } = recorder();
    makeReporter(spawner, { ...PANE_ENV, ROSSII_HERDR_AGENT_LABEL: "rossii-host" }).report("idle");
    expect(calls[0]!.args[calls[0]!.args.indexOf("--agent") + 1]).toBe("rossii-host");
  });

  test("a failing spawner never reaches the caller", async () => {
    const reporter = makeReporter(async () => { throw new Error("no herdr on PATH"); }, PANE_ENV);
    expect(() => reporter.report("working")).not.toThrow();
    const syncThrower = makeReporter(() => { throw new Error("spawn blew up"); }, PANE_ENV);
    expect(() => syncThrower.report("working")).not.toThrow();
    await Promise.resolve(); // let the rejected promise settle
  });

  test("the placeholder reporter is inert", () => {
    expect(NO_REPORTER.enabled).toBe(false);
    expect(() => NO_REPORTER.report("working")).not.toThrow();
  });
});
