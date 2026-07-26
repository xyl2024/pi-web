import { readFileSync } from "node:fs";
import { getRpcSession } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";

/**
 * Resolve an assistant message entry id to its payload index.
 *
 * Fast path: the live wrapper's in-memory map (populated by message_start hooks).
 * Cold path: count assistant entries in the session file in linear order — the
 * Nth assistant entry corresponds to payload index N (payload indexes are 1:1
 * with assistant messages on the default linear branch — same assumption
 * buildSessionContext makes).
 *
 * Used by both `/api/agent/[id]/payloads` (full payload) and
 * `/api/agent/[id]/payloads/summary` (status + duration only).
 */
export async function resolveEntryIdToIndex(
  sessionId: string,
  entryId: string,
): Promise<number | null> {
  // Fast path — live wrapper memory.
  const wrapper = getRpcSession(sessionId);
  if (wrapper) {
    const idx = wrapper.getPayloadIndexForEntry(entryId);
    if (idx !== undefined) return idx;
  }

  // Cold path — scan the session file. We deliberately do NOT start a
  // wrapper here; this route is read-only.
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  let assistantIndex = -1;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { type?: unknown; id?: unknown; message?: { role?: unknown } };
    if (e.type !== "message" || !e.message) continue;
    if (e.message.role !== "assistant") continue;
    assistantIndex += 1;
    if (e.id === entryId) return assistantIndex;
  }
  return null;
}