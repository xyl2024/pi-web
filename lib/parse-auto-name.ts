// Parses the raw LLM output of the auto-name prompt into a clean title.
//
// Behavior:
//   - Takes the first non-blank line.
//   - Trims surrounding ASCII quotes / smart quotes / brackets / periods.
//   - Rejects meta-answers ("null", "无", "无法判断", "n/a", "抱歉", etc).
//   - Truncates to MAX_TITLE_CHARS characters (CJK-heavy: 30 is plenty).
//   - Returns null on any rejection — callers fall back silently.
//
// The function is intentionally lenient about punctuation, code, and
// whitespace: the prompt asks the LLM for a clean title, so we don't try
// to validate beyond "is this plausibly a title".

export const MAX_TITLE_CHARS = 30;

// Substrings that indicate the LLM gave up or returned a meta-answer. Match
// case-insensitively against the cleaned (post-trim) first line.
const META_ANSWERS = /^(null|n\/?a|none|无|无主题|无法|无法判断|不能|抱歉|对不起|对不起无法|没有|不知道|no title|empty)$/i;

// Characters that can wrap a title and should be stripped from both ends.
// Includes Chinese full-width quotes, ASCII quotes, brackets, and trailing
// punctuation that's almost always noise.
const WRAPPER_CHARS = /^["'`「」『』《》\[\]【】()（）]+|["'`「」『』《》\[\]【】()（）。，,.;；:：!?？]+$/g;

export function parseAutoName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;

  // Take the first non-blank line. Models sometimes emit a stray leading
  // newline or a "Sure, here's a title:" preamble.
  const firstLine = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return null;

  // Strip wrapper characters repeatedly (in case of nested quotes).
  let cleaned = firstLine;
  for (let i = 0; i < 3; i++) {
    const next = cleaned.replace(WRAPPER_CHARS, "");
    if (next === cleaned) break;
    cleaned = next;
  }

  if (!cleaned) return null;
  if (META_ANSWERS.test(cleaned)) return null;
  if (cleaned.length > MAX_TITLE_CHARS) {
    cleaned = cleaned.slice(0, MAX_TITLE_CHARS);
    // Don't leave a dangling half-CJK char at the end. Code points are
    // fine for CJK; for emoji + ZWJ sequences we accept the truncation as-is.
  }

  return cleaned;
}
