#!/usr/bin/env bun
/**
 * The recap line is **on by default**, and `/recap-config off` is the only thing
 * that turns it off — for one directory at a time.
 *
 * This runs as its own process because `ROSSII_PROJECTS_DIR` is read once when
 * `src/project.ts` is first imported: the default is only provable in a process
 * that has never seen a real projects directory.
 */

import assert from "node:assert/strict";
import { chdir } from "node:process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "rossii-recap-"));
const projects = join(root, "projects");
const project = join(root, "project");
mkdirSync(projects, { recursive: true });
mkdirSync(project, { recursive: true });

// Before the import: the module resolves its directories once, at load time.
process.env.ROSSII_PROJECTS_DIR = projects;
delete process.env.CGOOSE_PROJECTS_DIR;
chdir(project);

/** The meta file this project owns — same key rule as `src/project.ts`. */
function recapPath(): string {
  const dir = resolve(".");
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return join(projects, `${basename(dir)}-${hash}.json`);
}

const { readProjectRecap, writeProjectRecap, writeProjectMeta, readProjectMeta } = await import("../src/project");

// ─── The default ────────────────────────────────────────────────────────────

assert.equal(existsSync(recapPath()), false, "nothing is written before the first command");
assert.equal(readProjectRecap().enabled, true, "recaps are ON with no project meta at all");

// A meta that only recorded history (a first launch) is still on.
writeProjectMeta("provider-a", "model-a");
assert.ok(existsSync(recapPath()), "the first write creates the file");
assert.equal(readProjectRecap().enabled, true, "recaps stay on when the meta has no `recap` key");
assert.equal(JSON.parse(readFileSync(recapPath(), "utf8")).recap, undefined, "no key is invented");

// ─── Off, then on again ─────────────────────────────────────────────────────

writeProjectRecap({ enabled: false });
assert.equal(readProjectRecap().enabled, false, "`/recap-config off` is remembered");
assert.deepEqual(
  JSON.parse(readFileSync(recapPath(), "utf8")).recap,
  { enabled: false, auto: true, idleMs: 30_000 },
  "off is stored, the other facets keep their defaults",
);

writeProjectRecap({ enabled: true });
assert.equal(readProjectRecap().enabled, true, "`/recap-config on` is remembered too");

// ─── The other two facets ──────────────────────────────────────────────────

assert.equal(readProjectRecap().auto, true, "automatic generation is on by default, like pi");
assert.equal(readProjectRecap().idleMs, 30_000, "30 s of idle, like pi");

writeProjectRecap({ auto: false });
assert.equal(readProjectRecap().auto, false, "`/recap-config auto off` is remembered");
assert.equal(readProjectRecap().enabled, true, "and does not touch the surface");
writeProjectRecap({ idleMs: 120_000 });
assert.equal(readProjectRecap().idleMs, 120_000, "`/recap-config auto 2m` is remembered");
assert.equal(readProjectRecap().auto, false, "and does not touch the automatic flag");
writeProjectRecap({ auto: true, idleMs: 0 });
assert.equal(readProjectRecap().auto, true, "a delay of 0 is a delay, not a switch");
assert.equal(readProjectRecap().idleMs, 0, "0 stays 0");

// ─── The key survives the other writers ─────────────────────────────────────

writeProjectRecap({ enabled: false, auto: true, idleMs: 30_000 });
writeProjectMeta("provider-b", "model-b");
let raw = JSON.parse(readFileSync(recapPath(), "utf8"));
assert.deepEqual(raw.recap, { enabled: false, auto: true, idleMs: 30_000 }, "`writeProjectMeta` carries the recap key over");
assert.equal(raw.modelHistory["provider-b"]?.[0], "model-b", "and still records the provider");
assert.ok(raw.providerHistory.includes("provider-a"), "and keeps the history");

// ─── Half-open states ───────────────────────────────────────────────────────

// Only an explicit `false` turns recaps off: a file edited by hand, or written
// by a version that did not know the key, must not.
raw = JSON.parse(readFileSync(recapPath(), "utf8"));
delete raw.recap;
writeFileSync(recapPath(), JSON.stringify(raw, null, 2));
assert.equal(readProjectRecap().enabled, true, "a meta without the key is on");
assert.equal(readProjectRecap().auto, true, "and automatic");
assert.equal(readProjectRecap().idleMs, 30_000, "and at 30 s");

// A half-written object (an older version, a hand edit) keeps what it has and
// defaults the rest.
writeFileSync(recapPath(), JSON.stringify({ recap: { idleMs: 5_000 } }, null, 2));
assert.deepEqual(readProjectRecap(), { enabled: true, auto: true, idleMs: 5_000 }, "missing keys default");

writeFileSync(recapPath(), JSON.stringify({ recap: { idleMs: "soon" } }, null, 2));
assert.equal(readProjectRecap().idleMs, 30_000, "a nonsense delay falls back to 30 s");

writeFileSync(recapPath(), "{ not json");
assert.equal(readProjectRecap().enabled, true, "an unreadable meta falls back to on");

// `readProjectMeta` keeps reporting the history alongside it.
writeProjectMeta("provider-c", "model-c");
assert.equal(readProjectMeta()?.modelHistory["provider-c"]?.[0], "model-c");

chdir(tmpdir());
rmSync(root, { recursive: true, force: true });
console.log("✅ recap is on and automatic by default, off only when asked");
