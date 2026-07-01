import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { createCollection } from "@/lib/http-collections-store";
import { HttpCollectionValidationError } from "@/lib/http-collections-schema";

const log = createLogger("api/http-collections/collections");

function validationResponse(err: HttpCollectionValidationError) {
  return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
}

// POST /api/http-collections/collections  body: CreateCollectionInput
export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      name?: unknown;
      description?: unknown;
    };
    const collection = createCollection({
      name: body.name as string,
      description: typeof body.description === "string" ? body.description : undefined,
    });
    log.info("collection created", {
      id: collection.id,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ collection }, { status: 201 });
  } catch (error) {
    if (error instanceof HttpCollectionValidationError) return validationResponse(error);
    log.error("collection create failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
