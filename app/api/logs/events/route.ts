import { getLogSnapshot, subscribeLog, type LogEntry } from "@/lib/logger";

export const dynamic = "force-dynamic";

// GET /api/logs/events — SSE stream for the LogsCenter right-panel tab.
//
// On connect: emit one `snapshot` event containing the current ring buffer.
// After that: emit one `entry` event per new log line.
// A 30s heartbeat keeps idle connections from being culled by intermediate
// proxies / Next.js itself (default ~120-150s). On client abort the
// subscription is released.
export async function GET(req: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // Controller is closed underneath us (client disconnected mid-flight).
          closed = true;
        }
      };

      // 1. Snapshot first — every entry currently in the ring buffer.
      const snapshot: LogEntry[] = getLogSnapshot();
      send("snapshot", { entries: snapshot });

      // 2. Live fan-out from this point on.
      const unsubscribe = subscribeLog((entry) => {
        send("entry", entry);
      });

      // 3. Heartbeat so intermediaries don't reap an idle connection.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          closed = true;
        }
      }, 30_000);

      // 4. Cleanup on client disconnect.
      const cleanup = () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}