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
// Creates $HOME/{dir_name} and returns the absolute cwd.
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

    const home = homedir();
    const dir = resolve(join(home, dirName));
    const homeRoot = home.endsWith(sep) ? home : home + sep;
    if (dir !== home && !dir.startsWith(homeRoot)) {
      return NextResponse.json({ error: "dir_name must create a directory inside HOME" }, { status: 400 });
    }
    if (existsSync(dir)) {
      return NextResponse.json({ error: `Directory already exists: ${dir}` }, { status: 409 });
    }

    mkdirSync(dir, { recursive: false });

    globalThis.__piCreatedSpaceRoots ??= new Set();
    globalThis.__piCreatedSpaceRoots.add(dir);
    globalThis.__piAllowedRootsCache?.roots.add(dir);

    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
