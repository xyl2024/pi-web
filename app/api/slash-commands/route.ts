import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { NextResponse } from "next/server";
import { DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath } from "@/lib/session-reader";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/slash-commands");

type SlashResource = {
  source: "prompt" | "skill";
  name: string;
  command: string;
  description: string;
  argumentHint?: string;
  path: string;
  location?: string;
  content: string;
};

async function resolveCwd(url: URL): Promise<string | null> {
  const cwd = url.searchParams.get("cwd");
  if (cwd) return cwd;

  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return null;

  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return null;

  return SessionManager.open(filePath).getHeader()?.cwd ?? null;
}

export async function GET(req: Request) {
  const startedAt = Date.now();

  try {
    const url = new URL(req.url);
    const cwd = await resolveCwd(url);

    if (!cwd) {
      return NextResponse.json({ error: "cwd or sessionId is required" }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
    await loader.reload();

    const prompts: SlashResource[] = loader.getPrompts().prompts.map((prompt) => ({
      source: "prompt",
      name: prompt.name,
      command: prompt.name,
      description: prompt.description,
      ...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}),
      path: prompt.filePath,
      location: prompt.sourceInfo.scope,
      content: prompt.content,
    }));

    const skills: SlashResource[] = await Promise.all(
      loader.getSkills().skills.map(async (skill) => ({
        source: "skill" as const,
        name: skill.name,
        command: `skill:${skill.name}`,
        description: skill.description,
        path: skill.filePath,
        location: skill.sourceInfo.scope,
        content: await readFile(skill.filePath, "utf-8"),
      }))
    );

    log.info("slash commands loaded", {
      cwd,
      promptCount: prompts.length,
      skillCount: skills.length,
      durationMs: elapsedMs(startedAt),
    });

    return NextResponse.json({ prompts, skills, commands: [...prompts, ...skills] });
  } catch (error) {
    log.error("slash commands failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
