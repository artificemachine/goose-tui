/**
 * herdr self-report: tell the pane's left-menu dot what this session is doing.
 *
 * herdr draws one coloured dot per pane and colours it from the last
 * `herdr pane report-agent` it received: grey/idle, amber/working, red/blocked.
 * The same shape as `pi-agent`'s `extensions/herdr-selfreport.ts` (itself lifted
 * from AndrewJacop/pi-herdr, MIT) is used here — an explicit gate on the pane
 * environment, an argv built by a pure function, and a fire-and-forget spawn so
 * a missing or hung `herdr` can never slow a turn down.
 *
 * Active only inside a herdr pane (`HERDR_PANE_ID` and `HERDR_ENV=1`), so
 * running rossii from a normal terminal stays a no-op. Disable with
 * `ROSSII_HERDR_NO_SELF_REPORT=1`.
 */

export type ReportState = "idle" | "working" | "blocked" | "unknown";

/** `herdr pane report-agent --source`, so herdr can tell who reported. */
export const SOURCE_ID = "goose-tui";
export const DEFAULT_AGENT_LABEL = "goose-tui";
const HERDR_BIN = "herdr";
/** Hard ceiling on one report-agent child; the spawn is never awaited. */
const SPAWN_TIMEOUT_MS = 5000;

/**
 * Runs `bin` with an argv and settles when the process does. Injected
 * everywhere so no test ever touches the real binary — see `defaultSpawner`
 * for the only place `node:child_process` is used.
 */
export type Spawner = (bin: string, args: string[]) => Promise<unknown>;

/** The knob a caller keeps: report a state, or nothing at all. */
export interface Reporter {
  /** False outside a herdr pane (or when disabled), so callers can skip work. */
  readonly enabled: boolean;
  report(state: ReportState): void;
}

/**
 * Whether to report at all. A pure function of an explicit env object (never
 * `process.env` at module scope) so it is testable without touching globals.
 */
export function isEnabled(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.HERDR_PANE_ID) && env.HERDR_ENV === "1" && !env.ROSSII_HERDR_NO_SELF_REPORT;
}

/** The argv for `herdr pane report-agent`, flag names as that subcommand prints them. */
export function buildArgs(
  paneId: string,
  agent: string,
  state: ReportState,
  seq: number,
  message?: string,
): string[] {
  const args = [
    "pane",
    "report-agent",
    paneId,
    "--source",
    SOURCE_ID,
    "--agent",
    agent,
    "--state",
    state,
    "--seq",
    String(seq),
  ];
  if (message) args.push("--message", message);
  return args;
}

/**
 * A reporter bound to one env and one spawner. `report` never throws and never
 * waits for the spawn; a repeated state is dropped, because herdr only draws a
 * transition and a turn calls `report("working")` on every retry.
 */
export function makeReporter(spawner: Spawner, env: NodeJS.ProcessEnv): Reporter {
  const enabled = isEnabled(env);
  const paneId = env.HERDR_PANE_ID;
  const agent = env.ROSSII_HERDR_AGENT_LABEL ?? DEFAULT_AGENT_LABEL;
  // Seq must keep increasing across restarts inside one pane, so it starts from
  // the clock: a low seq would look stale to herdr.
  let seq = Date.now();
  let last: ReportState | null = null;

  return {
    enabled,
    report(state) {
      if (!enabled || !paneId || state === last) return;
      last = state;
      seq += 1;
      try {
        Promise.resolve(spawner(HERDR_BIN, buildArgs(paneId, agent, state, seq))).catch(() => {});
      } catch {
        // A synchronous throw from the spawner must never reach the chat.
      }
    },
  };
}

/** A reporter that does nothing, for the paths that run outside a pane. */
export const NO_REPORTER: Reporter = { enabled: false, report() {} };

/**
 * The real spawner: `herdr` on PATH, argv array, no shell. Bounded by
 * `SPAWN_TIMEOUT_MS` so a hung child cannot outlive the chat.
 */
export async function defaultSpawner(bin: string, args: string[]): Promise<void> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { shell: false, windowsHide: true, stdio: "ignore" });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, SPAWN_TIMEOUT_MS);
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run();
    };
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", () => finish(() => resolve()));
  });
}

/** The reporter the chat uses: bound to the real spawner and `process.env`. */
export function createHerdrReporter(env: NodeJS.ProcessEnv = process.env): Reporter {
  return makeReporter(defaultSpawner, env);
}

/**
 * What each moment of a conversation means to herdr. `blocked` is a permission
 * prompt the user has to answer — the one time the session is waiting on a
 * human, which is exactly what the red dot is for.
 */
export const TURN_STATE = {
  start: "working",
  end: "idle",
  waiting: "blocked",
  resumed: "working",
  shutdown: "idle",
} as const satisfies Record<string, ReportState>;
