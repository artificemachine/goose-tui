/**
 * Inline autosuggestion — the fish / zsh-autosuggestions line.
 *
 * While the composer holds a non-empty prefix, the rest of the newest matching
 * history entry is shown in grey after the cursor. The suggestion is a *suffix*,
 * never a whole line, so accepting it is an append and can never rewrite what
 * was typed.
 *
 * Why it is separate from ./command-complete.ts: the `/…` menu is a navigable
 * list of names (goose's and the chat's), opened by a trigger character and
 * applied with Tab/Enter. The suggestion is silent, comes from *your own*
 * history, and is accepted with Right or End. Mixing the two would make Tab
 * ambiguous and would let a history entry hijack a `/` completion.
 *
 * Pure, like the rest of `src/acp/*.ts` helpers: the rendering lives in
 * `PromptEditor` (./chat-ui.ts), the decision lives here.
 */

export interface SuggestContext {
  /**
   * False as soon as the cursor is not at the end: fish and zsh only suggest
   * what they can append, and a suggestion in the middle of a line would be
   * accepted in the wrong place.
   */
  cursorAtEnd?: boolean;
  /** The `/…` completion menu owns the line while it is open. */
  menuOpen?: boolean;
}

/**
 * The grey remainder to paint after the cursor, or null.
 *
 * Newest match wins: `git s` suggests `tatus` even after `git stash` was used
 * earlier, because the most recent use is what a person is repeating.
 */
export function suggestSuffix(
  input: string,
  history: readonly string[],
  context: SuggestContext = {},
): string | null {
  if (context.menuOpen === true) return null;
  if (context.cursorAtEnd === false) return null;
  if (input === "" || input.trim() === "") return null;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i]!;
    if (entry.length > input.length && entry.startsWith(input)) {
      return entry.slice(input.length);
    }
  }
  return null;
}

/** Right or End accepts: the composer is set to the full line. */
export function acceptSuggestion(input: string, suffix: string | null): string {
  return suffix === null ? input : input + suffix;
}
