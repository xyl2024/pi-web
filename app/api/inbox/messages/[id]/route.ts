import { NextResponse } from "next/server";
import { deleteByIds } from "@/lib/inbox-store";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (typeof id !== "string" || id.length === 0) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  const deleted = deleteByIds([id]);
  if (deleted === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id, deleted });
}