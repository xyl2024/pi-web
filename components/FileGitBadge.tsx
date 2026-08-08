"use client";

/**
 * Git status letter indicator that sits at the right end of a FileExplorer
 * row. Renders a single colored letter (M, A, D, R, C, T, !, U) in the
 * status's theme color — no background circle, no ring, no white-on-color
 * treatment. The color matches the file/folder name tint the row already
 * applies, so the letter reads as a continuation of the row rather than
 * a separate sticker.
 *
 * Letter mapping (matches VSCode's resource explorer):
 *   A → A     (staged new file)
 *   M → M     (modified)
 *   D → D     (deleted)
 *   R → R     (renamed)
 *   C → C     (copied)
 *   T → T     (type change)
 *   U → !     (unmerged / conflict) — VSCode uses "!" for this
 *   ?? → U    (untracked)            — VSCode uses "U" for this
 *
 * The internal `U` vs `??` distinction matters because the badge letter
 * convention is the inverse of the GitFileStatus letters — "U" in our
 * type means conflict (most severe), but VSCode's badge uses "U" for
 * untracked (least severe). We resolve the ambiguity at render time.
 */

import type { GitFileStatus } from "@/lib/git-diff-types";

const BADGE_LETTER: Record<GitFileStatus, string> = {
  A: "A",
  M: "M",
  D: "D",
  R: "R",
  C: "C",
  T: "T",
  U: "!",
  "??": "U",
};

const BADGE_BG: Record<GitFileStatus, string> = {
  A: "var(--git-status-added)",
  M: "var(--git-status-modified)",
  D: "var(--git-status-deleted)",
  R: "var(--git-status-renamed)",
  C: "var(--git-status-renamed)",
  T: "var(--git-status-renamed)",
  U: "var(--git-status-conflict)",
  "??": "var(--git-status-untracked)",
};

/** Theme var for a given git status. Used by the FileExplorer to tint
 *  the file/folder name itself so the indicator reads as part of the
 *  row, not as a separate sticker. */
export function gitStatusColor(status: GitFileStatus): string {
  return BADGE_BG[status];
}

interface Props {
  status: GitFileStatus;
}

export function FileGitBadge({ status }: Props) {
  return (
    <span
      aria-hidden
      style={{
        flexShrink: 0,
        width: 12,
        marginLeft: 4,
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1,
        fontFamily: "var(--font-mono), monospace",
        color: BADGE_BG[status],
        textAlign: "center",
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      {BADGE_LETTER[status]}
    </span>
  );
}