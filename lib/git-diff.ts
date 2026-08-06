// Server-side git operations for the git diff panel. Runs `git` via
// execFile (never through a shell) so user-supplied paths/args are never
// interpreted as shell syntax — same pattern as lib/npx.ts.

import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, statSync } from "fs";
import path from "path";
import { createLogger } from "@/lib/logger";
import type { GitDiffFile, GitFileStatus } from "@/lib/git-diff-types";

const execFileAsync = promisify(execFile);

const log = createLogger("git-diff");

const GIT_TIMEOUT_MS = 10_000;

/** Cap on a single file's diff output; anything larger is truncated and
 *  flagged so the panel can show a warning instead of a frozen UI. */
export const MAX_DIFF_CHARS = 500_000;

/** Cap for reading untracked files to count their lines for +N stats. */
const MAX_UNTRACKED_READ_BYTES = 1024 * 1024;

interface GitResult {
  stdout: string;
}

/** Run `git <args>` in cwd. Returns null when git itself is missing or the
 *  command failed (exit code != 0). Throws on timeout. */
async function runGit(cwd: string, args: string[]): Promise<GitResult | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout };
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    // ENOENT means the git binary is not installed.
    if (code === "ENOENT") return null;
    // Any other failure (exit code != 0, timeout) — caller decides how to
    // surface it; most callers treat it as "not a git repo" or "no diff".
    log.warn("git command failed", { cwd, args: args.slice(0, 4), error: String(err) });
    return null;
  }
}

/** Absolute repo root for cwd, or null when cwd is not inside a git repo
 *  (or git is not installed). */
export async function getRepoRoot(cwd: string): Promise<string | null> {
  const res = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!res) return null;
  const root = res.stdout.trim();
  return root || null;
}

/** Current branch name, or null (detached HEAD / bare / no repo). */
async function getBranch(cwd: string): Promise<string | null> {
  const res = await runGit(cwd, ["branch", "--show-current"]);
  if (!res) return null;
  const branch = res.stdout.trim();
  return branch || null;
}

/** Parse `git status --porcelain=v1 -z` output into per-file records.
 *  -z disables C-style quoting, so paths with spaces/unicode come through
 *  verbatim. Renames emit `XY new\0old\0` — we keep the new path. */
function parseStatusZ(output: string): { path: string; status: GitFileStatus; hasStaged: boolean; hasUnstaged: boolean }[] {
  const records: { path: string; status: GitFileStatus; hasStaged: boolean; hasUnstaged: boolean }[] = [];
  const tokens = output.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.length < 3) continue; // "XY " minimum; trailing empty token
    const xy = tok.slice(0, 2);
    const filePath = tok.slice(3);

    // Rename/copy: `XY new\0old\0` — consume the old path token too.
    if (xy[0] === "R" || xy[0] === "C") {
      if (i + 1 < tokens.length) i++; // skip old path
    }

    // `??` is untracked; otherwise the first letter is the index (staged)
    // status, the second the worktree (unstaged) status.
    const hasStaged = xy !== "??" && xy[0] !== " ";
    const hasUnstaged = xy !== "??" && xy[1] !== " ";
    const status: GitFileStatus = xy === "??"
      ? "??"
      : (xy[0] !== " " ? xy[0] : xy[1]) as GitFileStatus;

    if (!filePath) continue;
    records.push({ path: filePath, status, hasStaged, hasUnstaged });
  }
  return records;
}

/** Parse `git diff --numstat -z` output into path → {add, del}. Renames
 *  emit `add\tdel\t\0old\0new\0` (empty path token) — record both paths so
 *  the status record (keyed by new path) always matches. */
function parseNumstatZ(output: string): Map<string, { add: number; del: number }> {
  const map = new Map<string, { add: number; del: number }>();
  const tokens = output.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+)\t(\d+)\t(.*)$/.exec(tokens[i]);
    if (!m) continue;
    const stats = { add: Number(m[1]), del: Number(m[2]) };
    const filePath = m[3];
    if (filePath) {
      map.set(filePath, stats);
    } else if (i + 2 < tokens.length) {
      // rename: empty path, then old\0new
      map.set(tokens[i + 1], stats);
      map.set(tokens[i + 2], stats);
      i += 2;
    }
  }
  return map;
}

/** Line count for an untracked file, used as its +N stat. Returns null when
 *  the file is binary, missing, or too large to read cheaply. */
function countUntrackedLines(repoRoot: string, filePath: string): { add: number; del: number } | null {
  const abs = path.join(repoRoot, filePath);
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_UNTRACKED_READ_BYTES) return null;
    const buf = readFileSync(abs);
    if (buf.includes(0)) return null; // binary — don't pretend to count
    let lines = 0;
    for (const b of buf) if (b === 0x0a) lines++;
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) lines++;
    return { add: lines, del: 0 };
  } catch {
    return null;
  }
}

/** Full change overview for a repo: repo root, branch, and the per-file
 *  list with combined staged+unstaged status and +N/-M stats. */
export async function getRepoStatus(cwd: string): Promise<{
  repoRoot: string | null;
  branch: string | null;
  files: GitDiffFile[];
}> {
  const repoRoot = await getRepoRoot(cwd);
  if (!repoRoot) {
    return { repoRoot: null, branch: null, files: [] };
  }

  const [statusRes, unstagedNumstat, stagedNumstat, branch] = await Promise.all([
    runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    runGit(repoRoot, ["diff", "--numstat", "-z"]),
    runGit(repoRoot, ["diff", "--cached", "--numstat", "-z"]),
    getBranch(repoRoot),
  ]);

  const files: GitDiffFile[] = [];
  if (statusRes) {
    const unstagedStats = unstagedNumstat ? parseNumstatZ(unstagedNumstat.stdout) : new Map();
    const stagedStats = stagedNumstat ? parseNumstatZ(stagedNumstat.stdout) : new Map();

    for (const rec of parseStatusZ(statusRes.stdout)) {
      // Untracked files don't appear in numstat; count lines directly.
      let add = 0, del = 0;
      if (rec.status === "??") {
        const counted = countUntrackedLines(repoRoot, rec.path);
        if (counted) { add = counted.add; del = counted.del; }
      } else {
        const u = unstagedStats.get(rec.path);
        const s = stagedStats.get(rec.path);
        add = (u?.add ?? 0) + (s?.add ?? 0);
        del = (u?.del ?? 0) + (s?.del ?? 0);
      }
      files.push({
        path: rec.path,
        status: rec.status,
        hasStaged: rec.hasStaged,
        hasUnstaged: rec.hasUnstaged,
        additions: add,
        deletions: del,
      });
    }
  }

  // Stable ordering: staged-first (M/A/D by index), then worktree changes,
  // then untracked — roughly matches what `git status` prints.
  files.sort((a, b) => {
    const rank = (f: GitDiffFile) => (f.status === "??" ? 2 : f.hasStaged ? 0 : 1);
    const r = rank(a) - rank(b);
    return r !== 0 ? r : a.path.localeCompare(b.path);
  });

  return { repoRoot, branch, files };
}

/** True when filePath is tracked by git (exists in the index). Distinguishes
 *  exit code 1 (not tracked) from other failures (git broken). */
async function isTracked(repoRoot: string, filePath: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", filePath], {
      cwd: repoRoot,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 1) return false; // not tracked
    log.warn("git ls-files failed", { repoRoot, filePath, error: String(err) });
    return false;
  }
}

export async function getFileDiff(
  repoRoot: string,
  filePath: string,
  staged: boolean,
): Promise<{ diff: string | null; truncated: boolean }> {
  const args = ["diff"];
  if (staged) args.push("--cached");
  if (!staged && !(await isTracked(repoRoot, filePath))) {
    // Untracked file — `git diff -- <path>` is empty; emulate a new file.
    return diffAgainstDevNull(repoRoot, filePath);
  }
  args.push("--", filePath);
  const res = await runGit(repoRoot, args);
  if (!res || !res.stdout) return { diff: null, truncated: false };
  return { diff: capDiff(res.stdout), truncated: res.stdout.length > MAX_DIFF_CHARS };
}

/** Diff against /dev/null for untracked files. `git diff --no-index` exits
 *  with code 1 when differences exist — that is a success here, so this
 *  bypasses runGit's null-on-nonzero rule. */
async function diffAgainstDevNull(repoRoot: string, filePath: string): Promise<{ diff: string | null; truncated: boolean }> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--no-index", "/dev/null", path.join(repoRoot, filePath)],
      { cwd: repoRoot, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    );
    return { diff: capDiff(stdout), truncated: stdout.length > MAX_DIFF_CHARS };
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    // Exit code 1 = differences found; stdout still carries the diff.
    if (code === 1) {
      const stdout = (err as { stdout?: string }).stdout ?? "";
      return { diff: capDiff(stdout), truncated: stdout.length > MAX_DIFF_CHARS };
    }
    if (code === "ENOENT") return { diff: null, truncated: false };
    log.warn("git diff --no-index failed", { repoRoot, filePath, error: String(err) });
    return { diff: null, truncated: false };
  }
}

function capDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return diff.slice(0, MAX_DIFF_CHARS);
}
