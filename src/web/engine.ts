/**
 * The engine behind the web surface: one goose ACP session, driven from HTTP.
 *
 * It reuses the shipped client (`src/acp/client.ts`) instead of a second
 * transport, so the browser talks to exactly the agent the TUI talks to —
 * same handshake, same custom requests, same cancellation. Everything is
 * injected, so the tests drive it with a fake client and never spawn goose.
 */

import { newSessionMeta } from "../acp/session-meta";
import { toWebEvent, type WebEvent } from "./event";
import { journalError } from "../journal";
import type { SessionNotification } from "../acp/types";

export interface EngineClient {
  initialize(capabilities: unknown): Promise<unknown>;
  newSession(request: unknown): Promise<{ sessionId: string }>;
  prompt(sessionId: string, prompt: unknown[], timeoutMs?: number): Promise<{ stopReason?: string }>;
  cancel(sessionId: string): void;
  onUpdate(callback: (notification: SessionNotification) => void): void;
  setPromptHandlers?(handlers: { requestPermission: (params: unknown) => Promise<unknown> }): void;
  stop(): Promise<void> | void;
}

export interface WebEngineOptions {
  /** Builds the client (the default spawns goose); tests pass a fake. */
  client: () => EngineClient;
  /** Where the events go — the SSE stream in production. */
  emit: (event: WebEvent) => void;
  cwd?: string;
  provider?: string;
  model?: string;
  /** Auto-approve tool permissions (a browser has no permission dialog yet). */
  autoApprove?: boolean;
  /** Absolute cap for one turn, in ms. 0 disables the cap. */
  turnTimeoutMs?: number;
}

export class WebEngine {
  private client: EngineClient | null = null;
  private sessionId: string | null = null;
  private busy = false;
  private readonly opts: WebEngineOptions;

  constructor(opts: WebEngineOptions) {
    this.opts = opts;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** Spawn the agent, handshake, and open a session. Idempotent. */
  async start(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const client = this.opts.client();
    this.client = client;

    client.onUpdate((notification) => {
      const event = toWebEvent(notification);
      if (event) this.opts.emit(event);
    });
    client.setPromptHandlers?.({
      requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
    });

    await client.initialize({
      fs: { readTextFile: true, writeTextFile: true },
      _meta: { goose: { customNotifications: true } },
    });

    const response = await client.newSession({
      cwd: this.opts.cwd ?? process.cwd(),
      mcpServers: [],
      _meta: newSessionMeta({
        sessionTitle: "rossii web",
        client: "rossii-web",
        enabledExtensions: undefined,
      }),
    });
    this.sessionId = response.sessionId;
    return this.sessionId;
  }

  /**
   * Send one prompt and wait for the turn to end. A second prompt while a turn
   * runs is refused rather than queued: the browser surface has no queue UI, and
   * silently dropping the text would be worse than saying so.
   */
  async prompt(text: string): Promise<void> {
    const sessionId = await this.start();
    if (this.busy) {
      this.opts.emit({ type: "error", message: "a turn is already running" });
      return;
    }
    this.busy = true;
    try {
      const result = await this.client!.prompt(
        sessionId,
        [{ type: "text", text }],
        this.opts.turnTimeoutMs ?? 0,
      );
      this.opts.emit({ type: "done", stopReason: (result as { stopReason?: string }).stopReason });
    } catch (error) {
      // The journal holds the redacted message; the browser gets the same text.
      this.opts.emit({ type: "error", message: journalError("web.turn", error).message });
    } finally {
      this.busy = false;
    }
  }

  /** Ask the agent to stop the turn it is running. */
  cancel(): void {
    if (this.sessionId) this.client?.cancel(this.sessionId);
  }

  async stop(): Promise<void> {
    await this.client?.stop();
    this.client = null;
    this.sessionId = null;
    this.busy = false;
  }
}

/** The production client factory: the same spawn+env the TUI uses. */
export function defaultClientFactory(opts: { cwd?: string; provider?: string; model?: string }): EngineClient {
  // Imported lazily so a test that injects its own client never loads the
  // transport (and never needs a goose binary on PATH).
  const { AcpClient } = require("../acp/client") as typeof import("../acp/client");
  const client = AcpClient.spawn({
    cwd: opts.cwd,
    env: {
      ...(opts.provider ? { GOOSE_PROVIDER: opts.provider } : {}),
      ...(opts.model ? { GOOSE_MODEL: opts.model } : {}),
    },
  });
  // SAFETY: AcpClient implements every method EngineClient declares, with the same
  // arities; the structural difference is only the concrete ACP request types.
  return client as unknown as EngineClient;
}
