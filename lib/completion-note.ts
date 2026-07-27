/**
 * Pure helpers for the `completion_note` field on a todo.
 *
 * Shared between server (`lib/todo-store.ts` validates the post-patch value
 * when `done` flips to true) and client (`components/TodoPanel.tsx`
 * pre-flights before the user toggles done, so we can auto-focus the editor
 * instead of round-tripping a doomed PATCH).
 */

/**
 * Does the stored / in-progress completion-note HTML carry any non-whitespace
 * text? `<p></p>` and `<p> </p>` both have non-zero length but no meaningful
 * content — strip tags and whitespace, then check there's something left.
 *
 * Note: the regex strips HTML tags naively. That's intentional here — we
 * only need a presence check, not a parser. The server is still the source
 * of truth; this just mirrors the server-side rule for instant UI feedback.
 */
export function hasCompletionNoteContent(value: string | undefined | null): boolean {
  if (!value) return false;
  const text = value.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
  return text.length > 0;
}