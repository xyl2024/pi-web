import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";

export const dynamic = "force-dynamic";

function cleanPromptName(value: string): string {
  return value.trim().replace(/^\/+/, "").replace(/\.md$/i, "");
}

function isValidPromptName(name: string): boolean {
  return Boolean(name) && !name.startsWith(".") && !/[\/\\\s\x00-\x1F\x7F]/.test(name);
}

function promptFileContent(description: string, argumentHint: string, content: string): string {
  const frontmatter: string[] = [];
  if (description.trim()) frontmatter.push(`description: ${JSON.stringify(description.trim())}`);
  if (argumentHint.trim()) frontmatter.push(`argument-hint: ${JSON.stringify(argumentHint.trim())}`);

  const body = content.endsWith("\n") ? content : `${content}\n`;
  if (frontmatter.length === 0) return body;
  return `---\n${frontmatter.join("\n")}\n---\n${body}`;
}

// GET /api/prompts?cwd=<path>
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  if (!existsSync(cwd)) return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });

  try {
    const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
    await loader.reload();
    const { prompts, diagnostics } = loader.getPrompts();
    return NextResponse.json({ prompts, diagnostics });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST /api/prompts - create a prompt template in ~/.pi/agent/prompts or <cwd>/.pi/prompts
export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      cwd?: string;
      scope?: "global" | "project";
      name?: string;
      description?: string;
      argumentHint?: string;
      content?: string;
    };

    const cwd = body.cwd;
    const scope = body.scope ?? "global";
    const name = cleanPromptName(body.name ?? "");
    const content = body.content ?? "";

    if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (!existsSync(cwd)) return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    if (!isValidPromptName(name)) {
      return NextResponse.json({ error: "Prompt name must not contain whitespace or path separators" }, { status: 400 });
    }
    if (!content.trim()) return NextResponse.json({ error: "content required" }, { status: 400 });

    const dir = scope === "project"
      ? join(cwd, ".pi", "prompts")
      : join(getAgentDir(), "prompts");
    const filePath = join(dir, `${name}.md`);

    if (existsSync(filePath)) return NextResponse.json({ error: "prompt already exists" }, { status: 409 });

    await mkdir(dir, { recursive: true });
    await writeFile(filePath, promptFileContent(body.description ?? "", body.argumentHint ?? "", content), "utf8");

    return NextResponse.json({ success: true, filePath });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
