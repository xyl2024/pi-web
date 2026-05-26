import { NextResponse } from "next/server";
import { runNpx } from "@/lib/npx";
import { createLogger, elapsedMs } from "@/lib/logger";

export const dynamic = "force-dynamic";

const ANSI_RE = /\x1B\[[0-9;]*m/g;
const log = createLogger("api/skills/install");

// POST /api/skills/install  body: { package: string; scope: "global" | "project"; cwd?: string }
export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const { package: pkg, scope, cwd } = await req.json() as { package?: string; scope?: string; cwd?: string };
    if (!pkg?.trim()) {
      log.warn("skill install rejected", { reason: "missing package", durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: "package required" }, { status: 400 });
    }

    const isGlobal = scope !== "project";
    const args = ["skills", "add", pkg.trim(), "-y", "--agent", "pi"];
    if (isGlobal) args.push("-g");

    log.info("skill install started", {
      package: pkg.trim(),
      scope: isGlobal ? "global" : "project",
      cwd: !isGlobal ? cwd : undefined,
    });
    const { stdout, stderr } = await runNpx(args, {
      timeout: 60000,
      cwd: !isGlobal && cwd ? cwd : undefined,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    const output = (stdout + stderr).replace(ANSI_RE, "");
    const success = /Installation complete|Installed \d+ skill/.test(output);
    if (!success) {
      log.warn("skill install failed", {
        package: pkg.trim(),
        scope: isGlobal ? "global" : "project",
        durationMs: elapsedMs(startedAt),
      });
      return NextResponse.json({ error: output.slice(-300) || "Install failed" }, { status: 500 });
    }
    log.info("skill install completed", {
      package: pkg.trim(),
      scope: isGlobal ? "global" : "project",
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ success: true, output });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = ((err.stdout ?? "") + (err.stderr ?? "")).replace(ANSI_RE, "");
    log.error("skill install error", { error: err.message ?? String(e), durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: output || (err.message ?? String(e)) }, { status: 500 });
  }
}
