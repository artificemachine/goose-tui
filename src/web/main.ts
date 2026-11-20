#!/usr/bin/env bun
/**
 * `goose-tui web` — the same goose ACP session, served to a browser.
 *
 * The TUI owns the terminal; this owns a port. Both drive the identical
 * transport (`src/acp/client.ts`), so a browser turn and a TUI turn reach the
 * same agent with the same handshake.
 *
 *   goose-tui web                          # http://127.0.0.1:8787
 *   rossii web --port 9000 --host 0.0.0.0
 *   bun run src/web/main.ts             # same thing, from a source checkout
 *
 * Environment:
 *   PORT                 default 8787
 *   HOST                 default 127.0.0.1 (loopback only — a browser is a
 *                        remote control for a shell-capable agent)
 *   ROSSII_WEB_PROVIDER  optional GOOSE_PROVIDER for the session
 *   ROSSII_WEB_MODEL     optional GOOSE_MODEL for the session
 *   ROSSII_WEB_CWD       working directory for the agent, default $PWD
 *   ROSSII_WEB_TIMEOUT_MS absolute turn cap, default 0 (no cap)
 */

import { WebEngine, defaultClientFactory } from "./engine";
import { createApp } from "./server";

export interface WebServerOptions {
  port?: number;
  hostname?: string;
  cwd?: string;
  provider?: string;
  model?: string;
  turnTimeoutMs?: number;
}

export interface RunningWebServer {
  /** The port actually bound (`--port 0` lets the OS choose). */
  port: number;
  /** The address actually bound; loopback unless the operator chose another. */
  hostname: string;
  stop: () => void;
}

function assertPort(port: number, raw: string | undefined): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`goose-tui web: invalid port ${raw ?? port}`);
  }
}

/**
 * Serve the browser surface on this process. Returns the bound port so a caller
 * (or a test) reaches it without guessing what `--port 0` resolved to.
 */
export function startWebServer(opts: WebServerOptions = {}): RunningWebServer {
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  assertPort(port, process.env.PORT);
  const hostname = opts.hostname ?? process.env.HOST ?? "127.0.0.1";
  const cwd = opts.cwd ?? process.env.ROSSII_WEB_CWD ?? process.cwd();

  const app = createApp({
    createEngine: (emit) =>
      new WebEngine({
        emit,
        cwd,
        provider: opts.provider,
        model: opts.model,
        turnTimeoutMs: opts.turnTimeoutMs ?? 0,
        client: () => defaultClientFactory({ cwd, provider: opts.provider, model: opts.model }),
      }),
  });

  const server = Bun.serve({ port, hostname, fetch: app.fetch });
  return {
    // Bun leaves `port` undefined for a socket-only server; this one is TCP.
    port: server.port ?? port,
    hostname: server.hostname ?? hostname,
    stop: () => {
      app.dispose();
      server.stop(true);
    },
  };
}

/** The argument for `--name value`, or undefined when the flag is absent. */
function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`goose-tui web: --${name} needs a value`);
  }
  return value;
}

/** `goose-tui web [--port N] [--host H] [--cwd DIR]`. */
export async function runWeb(argv: string[]): Promise<number> {
  const rawPort = flagValue(argv, "port") ?? process.env.PORT;
  const port = Number(rawPort ?? 8787);
  assertPort(port, rawPort);

  const server = startWebServer({
    port,
    hostname: flagValue(argv, "host") ?? process.env.HOST ?? "127.0.0.1",
    cwd: flagValue(argv, "cwd") ?? process.env.ROSSII_WEB_CWD ?? process.cwd(),
    provider: process.env.ROSSII_WEB_PROVIDER,
    model: process.env.ROSSII_WEB_MODEL,
    turnTimeoutMs: Number(process.env.ROSSII_WEB_TIMEOUT_MS ?? 0),
  });

  console.log(`goose-tui web on http://${flagValue(argv, "host") ?? process.env.HOST ?? "127.0.0.1"}:${server.port}`);

  const shutdown = (): void => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Serve until a signal arrives; the listeners above own the exit.
  await new Promise<void>(() => {});
  return 0;
}

if (import.meta.main) {
  process.exit(await runWeb(process.argv.slice(2)));
}
