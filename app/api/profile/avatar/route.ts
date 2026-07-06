import { NextResponse } from "next/server";
import { avatarExists, getAvatarPath, removeAvatar, writeAvatar } from "@/lib/profile-store";
import { createLogger, elapsedMs } from "@/lib/logger";
import { readFileSync } from "fs";

const log = createLogger("api/profile/avatar");

const MAX_AVATAR_SIZE = 5 * 1024 * 1024;

export const dynamic = "force-dynamic";

// GET /api/profile/avatar  →  image/png bytes, or 404 if no avatar
export async function GET() {
  const startedAt = Date.now();
  try {
    if (!avatarExists()) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const buffer = readFileSync(getAvatarPath());
    log.info("avatar served", { size: buffer.length, durationMs: elapsedMs(startedAt) });
    // No caching — the profile block uses ?k=<refreshKey> as cache-buster,
    // and we want a fresh upload to be visible immediately.
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-cache, must-revalidate",
      },
    });
  } catch (error) {
    log.error("avatar serve failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/profile/avatar  multipart/form-data "file"  (image/png only)
export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file field is required" }, { status: 400 });
    }
    if (file.type !== "image/png") {
      return NextResponse.json({ error: "only image/png is supported" }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "file is empty" }, { status: 400 });
    }
    if (file.size > MAX_AVATAR_SIZE) {
      return NextResponse.json(
        { error: `file too large (max ${MAX_AVATAR_SIZE} bytes)` },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    writeAvatar(buffer);
    log.info("avatar uploaded", {
      size: buffer.length,
      mime: file.type,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    log.error("avatar upload failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/profile/avatar
export async function DELETE() {
  const startedAt = Date.now();
  try {
    removeAvatar();
    log.info("avatar deleted", { durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ success: true });
  } catch (error) {
    log.error("avatar delete failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}