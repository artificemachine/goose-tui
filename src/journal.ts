/**
 * The error journal: every failure the process reports also leaves a line on
 * disk, so an error that scrolled off a terminal or a browser tab can still be
 * read afterwards.
 *
 *   <state dir>/errors.jsonl          one JSON line per occurrence
 *   <state dir>/reports/<id>.json     one report per distinct failure, counted,
 *                                     labelled `AI-gen`, waiting to be published
 *
 * The state directory is `$ROSSII_STATE_DIR`, else `$XDG_STATE_HOME/rossii`,
 * else `~/.local/state/rossii`. Everything is written owner-only, and secrets
 * are redacted before a byte reaches the disk.
 *
 * Journaling never throws: a caller is already handling a failure. When the
 * journal itself cannot be written, that is announced on stderr together with
 * the error it was carrying, so nothing is lost silently.
 */

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export interface JournalEntry {
  ts: string;
  scope: string;
  message: string;
  /** Identifies the failure across occurrences: same scope, same message. */
  fingerprint: string;
}

export interface JournalOptions {
  /** Environment whose secret values are redacted (default: the process's). */
  env?: Record<string, string | undefined>;
}

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
/** Shorter values are too likely to be ordinary words to blank out everywhere. */
const MIN_SECRET_LENGTH = 8;

export function journalDir(): string {
  if (process.env.ROSSII_STATE_DIR) return process.env.ROSSII_STATE_DIR;
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "rossii");
}

/** Replace every secret value of `env`, and any bearer token, in `text`. */
export function redactSecrets(text: string, env: Record<string, string | undefined> = process.env): string {
  let redacted = text;
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH || !SECRET_NAME.test(name)) continue;
    redacted = redacted.split(value).join(`[redacted:${name}]`);
  }
  return redacted.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]");
}

function ownerOnlyDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writeReport(dir: string, entry: JournalEntry): void {
  const reportsDir = join(dir, "reports");
  ownerOnlyDir(reportsDir);
  const path = join(reportsDir, `${entry.fingerprint}.json`);
  const known = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")) as { firstSeen: string; count: number; published: boolean }
    : { firstSeen: entry.ts, count: 0, published: false };
  const report = {
    fingerprint: entry.fingerprint,
    scope: entry.scope,
    message: entry.message,
    firstSeen: known.firstSeen,
    lastSeen: entry.ts,
    count: known.count + 1,
    label: "AI-gen",
    published: known.published,
  };
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Record a failure. `scope` names where it happened (`fatal`, `chat.turn`,
 * `web.turn`, …). Returns the entry, written or not.
 */
export function journalError(scope: string, error: unknown, options: JournalOptions = {}): JournalEntry {
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactSecrets(raw, options.env ?? process.env);
  const entry: JournalEntry = {
    ts: new Date().toISOString(),
    scope,
    message,
    fingerprint: createHash("sha256").update(`${scope}\n${message}`).digest("hex").slice(0, 16),
  };
  try {
    const dir = journalDir();
    ownerOnlyDir(dir);
    const path = join(dir, "errors.jsonl");
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    writeReport(dir, entry);
  } catch (writeError) {
    const reason = writeError instanceof Error ? writeError.message : String(writeError);
    process.stderr.write(`error journal unavailable (${reason}); unrecorded ${scope} error: ${message}\n`);
  }
  return entry;
}
