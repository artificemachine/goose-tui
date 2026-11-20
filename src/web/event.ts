/**
 * ACP session updates → the flat events the web client understands.
 *
 * Deliberately pure: the browser surface, the SSE stream and the engine all
 * speak this shape, so the mapping can be pinned by unit tests without a goose
 * process, a socket or a terminal.
 */

import type { SessionNotification } from "../acp/types";

export type WebEvent =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; id: string; title: string; status: string }
  | { type: "done"; stopReason?: string }
  | { type: "error"; message: string };

/**
 * One `session/update` notification as a client event, or `null` when the
 * update carries nothing a chat bubble can show (usage counters, config
 * options, available commands, session titles — the web surface ignores them).
 */
export function toWebEvent(notification: SessionNotification): WebEvent | null {
  const update = notification?.update;
  if (!update || typeof update.sessionUpdate !== "string") return null;

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = (update as { content?: { type?: string; text?: string } }).content;
      if (content?.type !== "text" || typeof content.text !== "string") return null;
      return { type: "text", text: content.text };
    }
    case "agent_thought_chunk": {
      const content = (update as { content?: { type?: string; text?: string } }).content;
      if (content?.type !== "text" || typeof content.text !== "string") return null;
      return { type: "thought", text: content.text };
    }
    case "tool_call":
    case "tool_call_update": {
      const call = update as { toolCallId?: string; title?: string; status?: string };
      if (!call.toolCallId) return null;
      return {
        type: "tool",
        id: call.toolCallId,
        title: call.title ?? call.toolCallId,
        status: call.status ?? "pending",
      };
    }
    default:
      return null;
  }
}

/** Server-Sent Events frame for one event. */
export function sseFrame(event: WebEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
