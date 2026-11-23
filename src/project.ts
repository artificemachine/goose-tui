/**
 * Per-project meta — remembers last used provider/model
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { env } from "./utils";

// ─── Paths ───────────────────────────────────────────────────────────────────

/**
 * Same rule as the sets/config directory (see rossii-config.ts): the old
 * `~/.config/cgoose/projects` is used only while the new one does not exist.
 */
const ROSSII_PROJECTS_DIR = (() => {
  const override = env("PROJECTS_DIR");
  if (override) return override;
  const current = join(homedir(), ".config", "rossii", "projects");
  const legacy = join(homedir(), ".config", "cgoose", "projects");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
})();

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectMeta {
  /** History of models used per provider (first = last used) */
  modelHistory: Record<string, string[]>;
  /** History of providers used in this project (first = last used) */
  providerHistory: string[];
  /** History of recipes used in this project (first = last used; "" = no recipe) */
  recipeHistory: string[];
  /** History of session sets used in this project (first = last used; "" = none) */
  setHistory: string[];
  /** Maps session name → worktree path (created via rossii git worktree integration) */
  worktrees?: Record<string, string>;
  /** Watchdog values set with `/timeout` in this directory; absent = inherit. */
  timeouts?: ProjectTimeouts;
  /** `/recap-config` state; absent = recaps on. */
  recap?: ProjectRecap;
}

/**
 * The recap line's settings for one directory. Absent keys keep the defaults
 * (`enabled` and `auto` on, 30 s of idle), which is what pi ships.
 */
export interface ProjectRecap {
  enabled: boolean;
  /** Generate a recap after a turn without being asked. */
  auto: boolean;
  /** Idle delay before that automatic recap; 0 = never. */
  idleMs: number;
}

/** `/recap-config` defaults: on, automatic after 30 s, like `pi-recap`. */
export const RECAP_DEFAULTS: ProjectRecap = { enabled: true, auto: true, idleMs: 30_000 };

/**
 * Chat watchdogs saved for this directory. Both are optional and independent:
 * a missing key means "not set here", so the set's default (or the built-in
 * one) applies — and `ROSSII_ACP_*_TIMEOUT_MS` above them all.
 */
export interface ProjectTimeouts {
  idleMs?: number;
  toolMs?: number;
}

// ─── Project key ─────────────────────────────────────────────────────────────

/** Get a stable project key: dirname + short hash of the full path */
function getProjectKey(): string {
  const dir = resolve(".");
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return `${basename(dir)}-${hash}`;
}

function getProjectMetaPath(): string {
  return join(ROSSII_PROJECTS_DIR, `${getProjectKey()}.json`);
}

/**
 * Composer input history for this directory: the same key as the meta file, so
 * a project's history follows the project rather than the terminal.
 * One JSON string per line (`./acp/input-history.ts`).
 */
export function getProjectHistoryPath(): string {
  return join(ROSSII_PROJECTS_DIR, `${getProjectKey()}.history.jsonl`);
}

// ─── Read / Write ────────────────────────────────────────────────────────────

export function readProjectMeta(): ProjectMeta | null {
  const path = getProjectMetaPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    // Migrate old format: { provider, model } → { provider, modelHistory }
    // Also handles the case where `model` is "" but modelHistory exists
    if (!raw.modelHistory) {
      raw.modelHistory = raw.model ? { [raw.provider ?? ""]: [raw.model] } : {};
    }
    // Migrate: ensure providerHistory exists (clean empty strings)
    if (!raw.providerHistory) {
      raw.providerHistory = raw.provider ? [raw.provider] : [];
    }
    // Migrate: ensure recipe history exists (clean empty strings)
    // "" (no recipe) is a valid recipeHistory entry, preserve it
    if (!raw.recipeHistory) {
      raw.recipeHistory = (raw.recipe !== undefined && raw.recipe !== null)
        ? [raw.recipe]
        : [];
    }
// Migrate: ensure setHistory exists
    if (!raw.setHistory) {
      raw.setHistory = [];
    }
    // Sanitize: remove empty strings from providerHistory
    raw.providerHistory = raw.providerHistory.filter(Boolean);
    return raw as ProjectMeta;
  } catch { return null; }
}

/**
 * Save provider + model + set selection to project meta.
 * Memory is per-project, not per-session.
 * recipe history is kept in ProjectMeta for backwards compatibility with
 * existing project files but is no longer actively tracked.
 */
export function writeProjectMeta(provider: string, model: string, sessionSet?: string): void {
  const dir = ROSSII_PROJECTS_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = getProjectMetaPath();

  // Merge with existing meta to preserve history
  const existing = existsSync(path)
    ? (() => { try { return JSON.parse(readFileSync(path, "utf-8")) as ProjectMeta; } catch { return null; } })()
    : null;

  const modelHistory: Record<string, string[]> = existing?.modelHistory ?? {};
  const prevList = (modelHistory[provider] ?? []).filter((m) => m !== model);
  modelHistory[provider] = [model, ...prevList].slice(0, 10); // keep max 10 per provider

  // Track provider history (most recent first, max 10)
  // Filter out empty strings to prevent corrupted entries
  const providerHistory = (existing?.providerHistory ?? []).filter(Boolean);
  const filteredProvHistory = providerHistory.filter((p) => p !== provider);
  const newProviderHistory = [provider, ...filteredProvHistory].slice(0, 10);

  // Track session set history (most recent first, max 10).
  // "" (none) is a legitimate choice.
  const effectiveSet = sessionSet !== undefined ? sessionSet : (existing?.setHistory?.[0] ?? "");
  const setHistory = existing?.setHistory ?? [];
  const filteredSetHistory = setHistory.filter((s) => s !== effectiveSet);
  const newSetHistory = [effectiveSet, ...filteredSetHistory].slice(0, 10);

  // Preserve existing worktree mappings when merging
  const worktrees = existing?.worktrees ?? {};

  writeFileSync(path, JSON.stringify({
    modelHistory,
    providerHistory: newProviderHistory,
    setHistory: newSetHistory,
    worktrees,
    // `/timeout` writes its own key; rewriting the file without it would make
    // the setting vanish on the next wizard run.
    ...(existing?.timeouts ? { timeouts: existing.timeouts } : {}),
    // `/recap-config` writes its own key, for the same reason.
    ...(existing?.recap ? { recap: existing.recap } : {}),
  }, null, 2) + "\n");
}

// ─── Timeouts (set from the chat with `/timeout`) ────────────────────────────

/** Watchdog values saved for this directory (empty object when none are). */
export function readProjectTimeouts(): ProjectTimeouts {
  const path = getProjectMetaPath();
  if (!existsSync(path)) return {};
  try {
    const meta = JSON.parse(readFileSync(path, "utf-8")) as ProjectMeta;
    const saved = meta.timeouts;
    if (!saved || typeof saved !== "object") return {};
    const out: ProjectTimeouts = {};
    if (typeof saved.idleMs === "number" && Number.isFinite(saved.idleMs) && saved.idleMs >= 0) {
      out.idleMs = saved.idleMs;
    }
    if (typeof saved.toolMs === "number" && Number.isFinite(saved.toolMs) && saved.toolMs >= 0) {
      out.toolMs = saved.toolMs;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Save (or forget, with `null`) one watchdog value for this directory.
 *
 * Merges into the existing file like `saveWorktreeMapping` — `writeProjectMeta`
 * rewrites it wholesale and would drop other keys — and removes the `timeouts`
 * object entirely once nothing is saved, so the file does not accumulate
 * empty shells.
 */
export function writeProjectTimeouts(patch: { idleMs?: number | null; toolMs?: number | null }): void {
  const dir = ROSSII_PROJECTS_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = getProjectMetaPath();

  let meta: Record<string, any> = {};
  if (existsSync(path)) {
    try {
      meta = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      meta = {};
    }
  }

  const current: ProjectTimeouts =
    meta.timeouts && typeof meta.timeouts === "object" ? { ...meta.timeouts } : {};

  for (const [key, value] of Object.entries(patch) as Array<["idleMs" | "toolMs", number | null | undefined]>) {
    if (value === undefined) continue;
    if (value === null) delete current[key];
    else current[key] = value;
  }

  if (Object.keys(current).length > 0) meta.timeouts = current;
  else delete meta.timeouts;

  writeFileSync(path, JSON.stringify(meta, null, 2) + "\n");
}

// ─── Recaps (set from the chat with `/recap-config`) ─────────────────────────

/**
 * The recap settings for this directory: **on by default**, like pi. Only an
 * explicit value turns something off — a missing file, a file without the key,
 * an unreadable file and a half-written object all keep the defaults.
 */
export function readProjectRecap(): ProjectRecap {
  const path = getProjectMetaPath();
  if (!existsSync(path)) return { ...RECAP_DEFAULTS };
  try {
    const meta = JSON.parse(readFileSync(path, "utf-8")) as ProjectMeta;
    const saved = meta.recap;
    if (!saved || typeof saved !== "object") return { ...RECAP_DEFAULTS };
    return {
      enabled: saved.enabled !== false,
      auto: saved.auto !== false,
      idleMs:
        typeof saved.idleMs === "number" && Number.isFinite(saved.idleMs) && saved.idleMs >= 0
          ? saved.idleMs
          : RECAP_DEFAULTS.idleMs,
    };
  } catch {
    return { ...RECAP_DEFAULTS };
  }
}

/** Is the recap line on for this directory? (`/recap-config on|off`) */
export function readProjectRecapEnabled(): boolean {
  return readProjectRecap().enabled;
}

/**
 * Save one facet of the recap settings, merging into the project meta.
 *
 * Merging rather than replacing matters: `/recap-config auto 2m` must not turn
 * the line off, and `/recap-config off` must not forget the delay.
 */
export function writeProjectRecap(patch: Partial<ProjectRecap>): void {
  const dir = ROSSII_PROJECTS_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = getProjectMetaPath();

  let meta: Record<string, any> = {};
  if (existsSync(path)) {
    try {
      meta = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      meta = {};
    }
  }

  const current: ProjectRecap = { ...RECAP_DEFAULTS, ...(meta.recap ?? {}) };
  meta.recap = { ...current, ...patch };
  writeFileSync(path, JSON.stringify(meta, null, 2) + "\n");
}

// ─── Worktree mapping ─────────────────────────────────────────────────────────

/** Save a session-to-worktree mapping in the project meta */
export function saveWorktreeMapping(sessionName: string, worktreePath: string): void {
  const dir = ROSSII_PROJECTS_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = getProjectMetaPath();

  let meta: Record<string, any> = {};
  if (existsSync(path)) {
    try { meta = JSON.parse(readFileSync(path, "utf-8")); } catch { meta = {}; }
  }

  if (!meta.worktrees) meta.worktrees = {};
  meta.worktrees[sessionName] = worktreePath;

  writeFileSync(path, JSON.stringify(meta, null, 2) + "\n");
}

/** Remove a session-to-worktree mapping from the project meta */
export function removeWorktreeMapping(sessionName: string): void {
  const path = getProjectMetaPath();
  if (!existsSync(path)) return;

  try {
    const meta = JSON.parse(readFileSync(path, "utf-8"));
    if (meta.worktrees?.[sessionName]) {
      delete meta.worktrees[sessionName];
      writeFileSync(path, JSON.stringify(meta, null, 2) + "\n");
    }
  } catch { /* ignore */ }
}

/** Get all worktree mappings for this project: { sessionName → worktreePath } */
export function getWorktreeMappings(): Record<string, string> {
  const path = getProjectMetaPath();
  if (!existsSync(path)) return {};
  try {
    const meta = JSON.parse(readFileSync(path, "utf-8"));
    return meta.worktrees ?? {};
  } catch { return {}; }
}