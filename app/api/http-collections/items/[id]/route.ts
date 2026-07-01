import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { deleteItem, getItemById, updateItem } from "@/lib/http-collections-store";
import {
  HttpCollectionNotFoundError,
  HttpCollectionValidationError,
} from "@/lib/http-collections-schema";
import type {
  BodyMode,
  HttpMethod,
  KVRow,
} from "@/hooks/httpStore";

const log = createLogger("api/http-collections/items/[id]");

function validationResponse(err: HttpCollectionValidationError) {
  return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
}

// GET /api/http-collections/items/[id]  — used for stale-item detection
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const { id } = await params;
  try {
    const item = getItemById(id);
    if (!item) {
      return NextResponse.json({ error: "item not found" }, { status: 404 });
    }
    log.info("item read", { id: item.id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ item });
  } catch (error) {
    log.error("item read failed", {
      id,
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/http-collections/items/[id]  body: UpdateItemInput
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const { id } = await params;
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
    const item = updateItem(id, {
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      method: typeof body.method === "string" ? (body.method as HttpMethod) : undefined,
      url: typeof body.url === "string" ? body.url : undefined,
      params: Array.isArray(body.params) ? (body.params as KVRow[]) : undefined,
      headers: Array.isArray(body.headers) ? (body.headers as KVRow[]) : undefined,
      bodyMode: typeof body.bodyMode === "string" ? (body.bodyMode as BodyMode) : undefined,
      body: typeof body.body === "string" ? body.body : undefined,
      timeoutMs: typeof body.timeoutMs === "number" || body.timeoutMs === null
        ? body.timeoutMs
        : undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
      collectionIds: Array.isArray(body.collectionIds)
        ? (body.collectionIds as string[])
        : undefined,
    });
    log.info("item updated", { id: item.id, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof HttpCollectionValidationError) return validationResponse(error);
    if (error instanceof HttpCollectionNotFoundError) {
      return NextResponse.json({ error: "item not found" }, { status: 404 });
    }
    log.error("item update failed", {
      id,
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/http-collections/items/[id]  — cascades unlinks (D1)
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const { id } = await params;
  try {
    const result = deleteItem(id);
    log.info("item deleted", {
      id: result.id,
      unlinkedFrom: result.unlinkedFrom,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof HttpCollectionNotFoundError) {
      return NextResponse.json({ error: "item not found" }, { status: 404 });
    }
    log.error("item delete failed", {
      id,
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
