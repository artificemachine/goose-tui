/**
 * The browser surface (`src/web/`): the tests
 * `docs/specs/SPEC-003-browser-surface.md` binds to.
 *
 * The HTTP app is driven through its `fetch` with a fake engine, so no agent
 * is spawned. Usage: bun test tests/
 */

import { afterEach, expect, test } from "bun:test";

import type { WebEvent } from "../src/web/event";
import { startWebServer } from "../src/web/main";
import { createApp, type App, type WebEngineLike } from "../src/web/server";

interface Fixture {
  app: App;
  prompts: string[];
  cancels: number;
  emit: (event: WebEvent) => void;
  engine: { busy: boolean };
}

function makeApp(): Fixture {
  const state = { busy: false };
  const fixture = { prompts: [] as string[], cancels: 0, engine: state } as Fixture;
  const engine: WebEngineLike = {
    start: async () => "s1",
    prompt: async (text) => { fixture.prompts.push(text); },
    cancel: () => { fixture.cancels++; },
    get isBusy() { return state.busy; },
  };
  fixture.app = createApp({
    createEngine: (emit) => {
      fixture.emit = emit;
      return engine;
    },
  });
  return fixture;
}

const url = (path: string): string => `http://goose-tui.test${path}`;

const post = (path: string, body: string): Request =>
  new Request(url(path), { method: "POST", body, headers: { "content-type": "application/json" } });

const savedHost = process.env.HOST;
const savedPort = process.env.PORT;

afterEach(() => {
  if (savedHost === undefined) delete process.env.HOST;
  else process.env.HOST = savedHost;
  if (savedPort === undefined) delete process.env.PORT;
  else process.env.PORT = savedPort;
});

test("health_reports_whether_a_turn_is_running", async () => {
  const fixture = makeApp();
  const idle = await fixture.app.fetch(new Request(url("/health")));
  expect(idle.status).toBe(200);
  expect(await idle.json()).toEqual({ ok: true, busy: false });

  fixture.engine.busy = true;
  const busy = await fixture.app.fetch(new Request(url("/health")));
  expect(await busy.json()).toEqual({ ok: true, busy: true });
});

test("prompt_is_accepted_or_refused_with_a_reason", async () => {
  const fixture = makeApp();
  const accepted = await fixture.app.fetch(post("/prompt", JSON.stringify({ text: "hello" })));
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({ accepted: true });
  expect(fixture.prompts).toEqual(["hello"]);

  for (const body of [JSON.stringify({ text: "   " }), JSON.stringify({ text: 42 }), JSON.stringify({})]) {
    const refused = await fixture.app.fetch(post("/prompt", body));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "text is required" });
  }
  const malformed = await fixture.app.fetch(post("/prompt", "not json"));
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ error: "body must be JSON" });
  // Nothing refused ever reached the agent.
  expect(fixture.prompts).toEqual(["hello"]);
});

test("cancel_reaches_the_engine", async () => {
  const fixture = makeApp();
  const response = await fixture.app.fetch(post("/cancel", ""));
  expect(response.status).toBe(202);
  expect(fixture.cancels).toBe(1);
});

test("event_stream_carries_engine_events_to_the_browser", async () => {
  const fixture = makeApp();
  const response = await fixture.app.fetch(new Request(url("/events")));
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(fixture.app.streams()).toBe(1);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toBe(": connected\n\n");

  const event: WebEvent = { type: "error", message: "provider returned 401" };
  fixture.emit(event);
  expect(decoder.decode((await reader.read()).value)).toBe(`data: ${JSON.stringify(event)}\n\n`);

  await reader.cancel();
  expect(fixture.app.streams()).toBe(0);
});

test("unknown_route_is_not_found", async () => {
  const fixture = makeApp();
  for (const request of [new Request(url("/admin")), new Request(url("/prompt")), post("/health", "")]) {
    const response = await fixture.app.fetch(request);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  }
});

test("web_binds_loopback_unless_told_otherwise", async () => {
  delete process.env.HOST;
  const server = startWebServer({ port: 0 });
  try {
    expect(server.hostname).toBe("127.0.0.1");
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(await health.json()).toEqual({ ok: true, busy: false });
  } finally {
    server.stop();
  }
});

test("invalid_port_is_refused_before_binding", () => {
  for (const port of [-1, 65536, 80.5, Number.NaN]) {
    expect(() => startWebServer({ port })).toThrow("goose-tui web: invalid port");
  }
});
