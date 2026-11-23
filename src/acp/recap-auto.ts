/**
 * The automatic recap timer — `pi-recap`'s `scheduleAutoRecap`, expressed on the
 * chat's own state.
 *
 * pi arms a timer when a turn ends, cancels it on any input or on the next turn,
 * and runs the recap if the session is still idle when it fires; the decision is
 * `shouldAutoRecap` (`./recap.ts`). rossii does exactly that, except the work is
 * goose's `/recap`: the timer sends that command *quietly* — no `❯ /recap` echo,
 * no turn separator — because a recap is not something the user said, and its
 * answer is routed to the line above the composer.
 *
 * One consequence worth naming: an automatic recap is a real turn. It costs one
 * provider call and one entry in goose's stored conversation (both halves hidden
 * from the agent). That is why it is off the moment a draft is in the composer, a
 * permission prompt is open, or the session has fewer than three turns.
 */

import { shouldAutoRecap } from "./recap";
import type { ChatContext } from "./chat-context";

/** Cancel a pending automatic recap (any input, any new turn, shutdown). */
export function cancelAutoRecap(ctx: ChatContext): void {
  if (ctx.recapTimer) clearTimeout(ctx.recapTimer);
  ctx.recapTimer = null;
}

/**
 * Arm the timer for the next idle window. Called when a turn ends.
 *
 * A turn that ended in an error, or with the agent dead, arms nothing: the recap
 * would report a failure as activity. The timer is deliberately not rescheduled
 * when it fires and is refused — the next turn end arms it again, which is the
 * behaviour pi has (a refused auto recap waits for new work to recap).
 */
export function armAutoRecap(ctx: ChatContext): void {
  cancelAutoRecap(ctx);
  if (!ctx.recapEnabled || !ctx.recapAuto || ctx.recapIdleMs <= 0) return;
  if (ctx.agentDead || !ctx.sessionId) return;
  const delay = Math.max(1_000, ctx.recapIdleMs);
  ctx.recapTimer = setTimeout(() => {
    ctx.recapTimer = null;
    const draft = ctx.editor?.getText?.() ?? "";
    if (
      !shouldAutoRecap({
        enabled: ctx.recapEnabled,
        auto: ctx.recapAuto,
        busy: ctx.busy,
        permissionOpen: ctx.activePermission !== null || ctx.permissionQueue.length > 0,
        draft,
        turns: ctx.turnsStarted,
        lastRecapTurn: ctx.lastRecapTurn,
      })
    ) {
      return;
    }
    submitQuietRecap(ctx);
  }, delay);
  // `unref` keeps a process that is only waiting for a recap alive only as long
  // as the chat itself: the TUI loop holds the terminal, not this timer.
  (ctx.recapTimer as unknown as { unref?: () => void }).unref?.();
}

/**
 * Ask goose for a recap without putting the request in the conversation: the
 * `❯ /recap` echo and the dashed turn rule are skipped (`submitPrompt` reads
 * `ctx.quietPrompt`), so the only visible result is the line above the composer.
 */
export function submitQuietRecap(ctx: ChatContext): void {
  if (ctx.busy || !ctx.sessionId) return;
  // Mark the turn *now*, not when the answer arrives: if the recap comes back
  // unrecognisable (a goose without the command, a model that ignores the
  // instruction), `neverTwiceInARow` must still hold — otherwise the timer arms
  // after that turn, fires, asks again, and the chat recaps itself in a loop.
  ctx.lastRecapTurn = ctx.turnsStarted;
  // Recorded at request time, like the turn: the answer is checked when the
  // turn ends (`finishTurn`), because a `/recap` goose runs as a prompt comes
  // back as prose and would otherwise fail silently.
  ctx.recapExpected = true;
  ctx.quietPrompt = true;
  // Imported lazily: `chat-io.ts` imports this module for the timer hooks.
  void import("./chat-io").then(({ submitPrompt }) => submitPrompt(ctx, "/recap"));
}
