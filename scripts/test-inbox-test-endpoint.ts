/**
 * Smoke test for the Inbox test push endpoint.
 * Usage: npx tsx scripts/test-inbox-test-endpoint.ts
 *
 * Drives the same POST handler the Settings UI hits, then reads the row back
 * via the store to confirm it landed. Cleans up after itself.
 */
import { POST } from "../app/api/inbox/test/route";
import { deleteByIds, listMessages } from "../lib/inbox-store";

async function callPost(body: unknown) {
  return POST(
    new Request("http://localhost/api/inbox/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as Request,
  );
}

async function main() {
  const tag = `__smoke_${Date.now()}`;
  const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

  // 1. Happy path: full payload
  const r1 = await callPost({
    source: tag,
    level: "warn",
    title: "smoke test",
    body: "hello body",
    href: "https://example.com",
  });
  const r1body = (await r1.json()) as { ok?: boolean; message?: { source: string; level: string; title: string; payload?: Record<string, unknown> } };
  results.push({
    name: "happy path 201 + payload roundtrip",
    ok: r1.status === 201 && r1body.ok === true && r1body.message?.source === tag && r1body.message?.level === "warn" && r1body.message?.payload?.body === "hello body" && r1body.message?.payload?.href === "https://example.com",
    detail: `status=${r1.status}`,
  });

  // 2. Minimal: no body / no href, no level (defaults to info)
  const r2 = await callPost({ source: tag, title: "minimal" });
  const r2body = (await r2.json()) as { message?: { level: string; payload?: unknown } };
  results.push({
    name: "minimal defaults level=info, no payload",
    ok: r2.status === 201 && r2body.message?.level === "info" && r2body.message?.payload === undefined,
    detail: `status=${r2.status}`,
  });

  // 3. Validation: empty source → 400 with field=source
  const r3 = await callPost({ source: "  ", title: "x" });
  const r3body = (await r3.json()) as { error?: string; field?: string };
  results.push({
    name: "empty source → 400 field=source",
    ok: r3.status === 400 && r3body.field === "source",
    detail: `status=${r3.status} field=${r3body.field}`,
  });

  // 4. Validation: bad level → 400
  const r4 = await callPost({ source: tag, title: "x", level: "panic" });
  const r4body = (await r4.json()) as { field?: string };
  results.push({
    name: "invalid level → 400 field=level",
    ok: r4.status === 400 && r4body.field === "level",
    detail: `status=${r4.status} field=${r4body.field}`,
  });

  // 5. Validation: empty title → 400
  const r5 = await callPost({ source: tag, title: "" });
  const r5body = (await r5.json()) as { field?: string };
  results.push({
    name: "empty title → 400 field=title",
    ok: r5.status === 400 && r5body.field === "title",
    detail: `status=${r5.status} field=${r5body.field}`,
  });

  // 6. Store-level: inserted rows are visible
  const rows = listMessages({ source: tag, limit: 10 });
  results.push({
    name: "store sees 2 inserted rows",
    ok: rows.length === 2,
    detail: `count=${rows.length}`,
  });

  // Cleanup
  deleteByIds(rows.map((r) => r.id));

  // Report
  let allOk = true;
  for (const r of results) {
    const marker = r.ok ? "✓" : "✗";
    console.log(`${marker} ${r.name}  (${r.detail ?? ""})`);
    if (!r.ok) allOk = false;
  }
  if (!allOk) {
    console.error("\nFAILED");
    process.exit(1);
  }
  console.log("\nOK");
}

void main();
