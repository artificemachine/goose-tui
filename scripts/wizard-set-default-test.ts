#!/usr/bin/env bun
/**
 * Unit tests for `defaultSetSelection` (src/rossii-config.ts) — the set the
 * wizard preselects on the `set` step. No TUI, no goose process.
 *
 * Why it is worth a test: a directory with no project meta used to preselect
 * None, and None means no extensions at all — `goose-tui` in a fresh clone
 * opened an agent with no file or shell tools (measured on goose 1.59.2: 0
 * tools, against 5 for a set naming `developer`).
 *
 * Usage: bun run test   (or `bun scripts/wizard-set-default-test.ts`)
 */

import assert from "node:assert/strict";
import { DEFAULT_PROFILE_SENTINEL, defaultSetSelection } from "../src/rossii-config";

type Check = [name: string, run: () => void];

const checks: Check[] = [
  ["no history at all: the profile is the default", () => {
    assert.equal(defaultSetSelection(undefined), DEFAULT_PROFILE_SENTINEL);
    assert.equal(defaultSetSelection([]), DEFAULT_PROFILE_SENTINEL);
  }],
  ["a set that was used stays selected", () => {
    assert.equal(defaultSetSelection(["development"]), "development");
    assert.equal(defaultSetSelection(["development", "review"]), "development");
  }],
  ["an explicit None in the history stays None — a choice, not an absence", () => {
    assert.equal(defaultSetSelection([""]), "");
    assert.equal(defaultSetSelection(["", "development"]), "");
  }],
  ["an explicit Default in the history stays Default", () => {
    assert.equal(defaultSetSelection([DEFAULT_PROFILE_SENTINEL]), DEFAULT_PROFILE_SENTINEL);
  }],
];

let failed = 0;
for (const [name, run] of checks) {
  try {
    run();
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.error(`❌ ${name}`);
    console.error(error);
  }
}

if (failed > 0) {
  console.error(`\n❌ ${failed} of ${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\n✅ ${checks.length} checks passed`);
