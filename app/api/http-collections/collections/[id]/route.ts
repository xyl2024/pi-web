import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { deleteCollection, updateCollection } from "@/lib/http-collections-store";
import {
  HttpCollectionNotFoundError,
  HttpCollectionValidationError,
} from "@/lib/http-collections-schema";

const log = createLogger("api/http-collections/collections/[id]");

function validationResponse(err: HttpCollectionValidationError) {
  return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
}

// PATCH /api/http-collections/collections/[id]  body: UpdateCollectionInput
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
    };
    const collection = updateCollection(id, {
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
    });
    log.info("collection updated", {
      id: collection.id,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ collection });
  } catch (error) {
    if (error instanceof HttpCollectionValidationError) return validationResponse(error);
    if (error instanceof HttpCollectionNotFoundError) {
      return NextResponse.json({ error: "collection not found" }, { status: 404 });
    }
    log.error("collection update failed", {
      id,
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/http-collections/collections/[id]  — unlinks items (C1) but does not delete them
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const { id } = await params;
  try {
    const result = deleteCollection(id);
    log.info("collection deleted", {
      id: result.id,
      unlinkedFrom: result.unlinkedFrom,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof HttpCollectionNotFoundError) {
      return NextResponse.json({ error: "collection not found" }, { status: 404 });
    }
    log.error("collection delete failed", {
      id,
      error,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
