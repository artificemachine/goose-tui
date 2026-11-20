/**
 * The HTTP surface: one page, one event stream, two actions.
 *
 * `createApp` takes the engine factory instead of an engine, because the engine
 * needs the event sink and the sink needs the connected clients — the factory
 * closes that loop without a second global. Tests pass a fake factory, so the
 * whole surface is exercised without goose, a port, or a browser.
 */

import { sseFrame, type WebEvent } from "./event";
import { journalError } from "../journal";

export interface WebEngineLike {
  start(): Promise<string>;
  prompt(text: string): Promise<void>;
  cancel(): void;
  readonly isBusy: boolean;
}

export interface AppOptions {
  /** Build the engine with the sink this app owns. */
  createEngine: (emit: (event: WebEvent) => void) => WebEngineLike;
}

export interface App {
  fetch: (request: Request) => Promise<Response>;
  /** Number of event streams currently open. */
  streams: () => number;
  dispose: () => void;
}

const PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>rossii web</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #16161e; color: #e0def4; display: flex; flex-direction: column; height: 100vh; }
  #log { flex: 1; overflow-y: auto; padding: 16px; white-space: pre-wrap; }
  .user { color: #ff79c6; }
  .text { color: #e0def4; }
  .thought { color: #6b6b80; font-style: italic; }
  .tool { color: #7dcfff; }
  .error { color: #f7768e; }
  form { display: flex; gap: 8px; padding: 12px; background: #1c1c26; border-top: 1px solid #2c2c3a; }
  textarea { flex: 1; resize: none; height: 3em; background: #13131a; color: inherit;
             border: 1px solid #2c2c3a; border-radius: 6px; padding: 8px; font: inherit; }
  button { background: #ff79c6; color: #16161e; border: 0; border-radius: 6px; padding: 0 16px;
           font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
</style>
<div id="log"></div>
<form id="f">
  <textarea id="t" placeholder="Ask goose… (Enter sends, Shift+Enter adds a line)"></textarea>
  <button id="send">Send</button>
</form>
<script>
  const log = document.getElementById("log");
  const textarea = document.getElementById("t");
  const button = document.getElementById("send");
  let line = null;
  const add = (cls, text) => {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  };
  const events = new EventSource("/events");
  events.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "text") {
      if (!line) line = add("text", "");
      line.textContent += event.text;
    } else if (event.type === "thought") {
      add("thought", event.text);
    } else if (event.type === "tool") {
      add("tool", "\u25AE " + event.title + " \u00B7 " + event.status);
    } else if (event.type === "error") {
      add("error", "\u26A0 " + event.message);
    } else if (event.type === "done") {
      line = null;
      button.disabled = false;
    }
    log.scrollTop = log.scrollHeight;
  };
  document.getElementById("f").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    add("user", "\u276F " + text);
    textarea.value = "";
    button.disabled = true;
    line = null;
    const response = await fetch("/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      add("error", "\u26A0 " + (await response.text()));
      button.disabled = false;
    }
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      document.getElementById("f").requestSubmit();
    }
  });
</script>
</html>`;

/** The page itself, exported so a test can assert it is served verbatim. */
export const PAGE_HTML = PAGE;

export function createApp(opts: AppOptions): App {
  const encoder = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

  const emit = (event: WebEvent): void => {
    const frame = encoder.encode(sseFrame(event));
    for (const client of clients) {
      try {
        client.enqueue(frame);
      } catch {
        // A closed stream throws on enqueue; drop it instead of failing the turn.
        clients.delete(client);
      }
    }
  };

  const engine = opts.createEngine(emit);

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  return {
    streams: () => clients.size,
    dispose: () => {
      for (const client of clients) {
        try {
          client.close();
        } catch {
          // already closed
        }
      }
      clients.clear();
    },
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (request.method === "GET" && url.pathname === "/events") {
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController;
            clients.add(streamController);
            streamController.enqueue(encoder.encode(": connected\n\n"));
          },
          cancel() {
            if (controller) clients.delete(controller);
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/prompt") {
        let body: { text?: unknown };
        try {
          body = (await request.json()) as { text?: unknown };
        } catch {
          return json({ error: "body must be JSON" }, 400);
        }
        if (typeof body.text !== "string" || !body.text.trim()) {
          return json({ error: "text is required" }, 400);
        }
        // The turn runs detached: the browser follows it on the event stream.
        void engine.prompt(body.text).catch((error: unknown) => {
          emit({ type: "error", message: journalError("web.turn", error).message });
        });
        return json({ accepted: true }, 202);
      }

      if (request.method === "POST" && url.pathname === "/cancel") {
        engine.cancel();
        return json({ cancelled: true }, 202);
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, busy: engine.isBusy });
      }

      return json({ error: "not found" }, 404);
    },
  };
}
