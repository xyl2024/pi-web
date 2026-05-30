import { NextResponse } from "next/server";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve, sep } from "path";

declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piCreatedSpaceRoots: Set<string> | undefined;
}

const INVALID_DIR_NAME_RE = /[/\\\0]/;

// POST /api/create-space
// Creates ~/.pi-web/workspace/{dir_name} and returns the absolute cwd.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { dir_name?: unknown };
    const dirName = typeof body.dir_name === "string" ? body.dir_name.trim() : "";

    if (!dirName) {
      return NextResponse.json({ error: "dir_name is required" }, { status: 400 });
    }
    if (dirName === "." || dirName === ".." || INVALID_DIR_NAME_RE.test(dirName)) {
      return NextResponse.json({ error: "dir_name must be a single directory name" }, { status: 400 });
    }

    const workspaceRoot = join(homedir(), ".pi-web", "workspace");
    const dir = resolve(join(workspaceRoot, dirName));
    const workspaceRootPrefix = workspaceRoot.endsWith(sep) ? workspaceRoot : workspaceRoot + sep;
    if (dir !== workspaceRoot && !dir.startsWith(workspaceRootPrefix)) {
      return NextResponse.json({ error: "dir_name must create a directory inside ~/.pi-web/workspace" }, { status: 400 });
    }
    if (existsSync(dir)) {
      return NextResponse.json({ error: `Directory already exists: ${dir}` }, { status: 409 });
    }

    mkdirSync(dir, { recursive: true });

    globalThis.__piCreatedSpaceRoots ??= new Set();
    globalThis.__piCreatedSpaceRoots.add(dir);
    globalThis.__piAllowedRootsCache?.roots.add(dir);

    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
