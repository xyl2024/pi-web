// Client-safe types for the git diff panel. No server-only imports here —
// this file is shared between the API routes (server) and GitDiffPanel
// (client), mirroring the pattern in show-file-tool-types.ts.

/** Per-file change status — git's own `--name-status` letters, plus
 *  `"??"` for untracked files (which name-status omits entirely). */
export type GitFileStatus =
  | "A"  // added (staged new file)
  | "M"  // modified
  | "D"  // deleted
  | "R"  // renamed
  | "C"  // copied
  | "T"  // type change
  | "U"  // unmerged
  | "??"; // untracked

export interface GitDiffFile {
  /** Path relative to the repo root. For renames this is the new path. */
  path: string;
  /** Staged-then-worktree combined status from `git status --porcelain`. */
  status: GitFileStatus;
  /** Whether the index (staged) side has changes for this file. */
  hasStaged: boolean;
  /** Whether the worktree (unstaged) side has changes for this file. */
  hasUnstaged: boolean;
  additions: number;
  deletions: number;
}

export interface GitStatusResponse {
  /** Absolute path of the repo root, or null when cwd is not a git repo. */
  repoRoot: string | null;
  branch: string | null;
  files: GitDiffFile[];
}

export interface GitDiffResponse {
  /** Unified diff text for the file, or null when there is no diff to show
   *  (e.g. untracked binary, or the file side requested has no changes). */
  diff: string | null;
  /** True when the diff was truncated because it exceeded the size cap. */
  truncated: boolean;
}
