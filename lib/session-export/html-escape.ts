// Server-safe HTML escape helper.
//
// Tiny in-house escape — we control the entire export HTML (no third-party HTML
// merging), so the 5 char escape below is enough and we avoid pulling in any new
// dependency. Use this for any user/LLM-controlled string that lands in an HTML
// attribute or inline-text position.

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
