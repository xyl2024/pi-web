import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { createItem } from "@/lib/http-collections-store";
import { HttpCollectionValidationError } from "@/lib/http-collections-schema";
import type {
  BodyMode,
  HttpMethod,
  KVRow,
} from "@/hooks/httpStore";

const log = createLogger("api/http-collections/items");

function validationResponse(err: HttpCollectionValidationError) {
  return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
}

// POST /api/http-collections/items  body: CreateItemInput
export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      name?: unknown;
      description?: unknown;
      method?: unknown;
      url?: unknown;
      params?: unknown;
      headers?: unknown;
      bodyMode?: unknown;
      body?: unknown;
      timeoutMs?: unknown;
      tags?: unknown;
      collectionIds?: unknown;
    };
    const item = createItem({
      name: body.name as string,
      description: typeof body.description === "string" ? body.description : undefined,
      method: body.method as HttpMethod,
      url: body.url as string,
      params: (Array.isArray(body.params) ? body.params : []) as KVRow[],
      headers: (Array.isArray(body.headers) ? body.headers : []) as KVRow[],
      bodyMode: (body.bodyMode ?? "none") as BodyMode,
      body: typeof body.body === "string" ? body.body : "",
      timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : null,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
      collectionIds: Array.isArray(body.collectionIds)
        ? (body.collectionIds as string[])
        : [],
    });
    log.info("item created", {
      id: item.id,
      collections: body.collectionIds,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    if (error instanceof HttpCollectionValidationError) return validationResponse(error);
    log.error("item create failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
