/**
 * Smoke test for `lib/token-audit-store.ts`. Runs all CRUD ops against a
 * temp DB (PI_WEB_TOKEN_AUDIT_DB env var override), prints results, exits.
 *
 * Usage:  npx tsx scripts/test-token-audit-store.ts
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Override DB path BEFORE importing anything that calls getTokenAuditDb.
const tmpDir = mkdtempSync(join(tmpdir(), "token-audit-test-"));
process.env.PI_WEB_TOKEN_AUDIT_DB = join(tmpDir, "test.db");

import {
  clearAllData,
  listCalls,
  recordCall,
  summarize,
  type Range,
  type Source,
  type TokenCallInsert,
} from "@/lib/token-audit-store";

function log(label: string, value: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
}

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`ASSERT FAILED: ${msg}`);
    cleanup();
    process.exit(1);
  }
}

function cleanup() {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

const NOW = Date.now();
const BASE: TokenCallInsert = {
  sessionId: "sess-1",
  messageId: "m1",
  source: "user",
  provider: "anthropic",
  modelId: "claude-sonnet-4-5",
  api: "anthropic-messages",
  ts: NOW,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costInput: 0.0003,
  costOutput: 0.0015,
  costRead: 0,
  costWrite: 0,
  costTotal: 0.0018,
  durationMs: 100,
  error: null,
};

(async () => {
  try {
    // 1. Empty initial state
    const empty = listCalls({ range: "all" as Range, limit: 100, offset: 0 });
    log("initial listCalls", empty);
    assert(empty.total === 0, "expected 0 rows initially");

    // 2. Insert 4 rows + 1 duplicate (session+message_id) that must dedupe
    recordCall({ ...BASE, messageId: "m1" });
    recordCall({
      ...BASE,
      messageId: "m2",
      inputTokens: 200,
      outputTokens: 100,
      costInput: 0.0006,
      costOutput: 0.003,
      costTotal: 0.0036,
    });
    recordCall({
      ...BASE,
      sessionId: "sess-2",
      messageId: "m3",
      source: "scheduled" as Source,
      provider: "openai",
      modelId: "gpt-4o",
      api: "openai-chat",
    });
    // Old row (60d ago) for range tests
    recordCall({
      ...BASE,
      messageId: "old",
      ts: NOW - 60 * 86_400_000,
    });
    // Duplicate — same sessionId + messageId as m1
    recordCall({ ...BASE, messageId: "m1" });

    const allCalls = listCalls({ range: "all", limit: 100, offset: 0 });
    log("listCalls(all) after inserts", { total: allCalls.total, count: allCalls.rows.length });
    assert(allCalls.total === 4, "INSERT OR IGNORE dedupes the (sess-1, m1) duplicate");

    // 3. Range filter
    const recent = listCalls({ range: "7d", limit: 100, offset: 0 });
    log("listCalls(7d)", { total: recent.total, count: recent.rows.length });
    assert(recent.total === 3, "7d range excludes the 60d-old row");
    const everything = listCalls({ range: "all", limit: 100, offset: 0 });
    assert(everything.total === 4, "all range includes the 60d-old row");

    // 4. Session filter
    const sess2 = listCalls({ range: "all", limit: 100, offset: 0, sessionId: "sess-2" });
    log("listCalls(sess-2)", sess2);
    assert(sess2.total === 1, "sessionId filter limits to sess-2");
    assert(sess2.rows[0].source === "scheduled", "source preserved through filter");
    assert(sess2.rows[0].provider === "openai", "provider roundtrip");

    // 5. summarize(groupBy=none)
    const sumNone = summarize("all", "none");
    log("summarize(all, none)", sumNone);
    assert(sumNone.buckets.length === 0, "no buckets for groupBy=none");
    assert(sumNone.totals.calls === 4, "totals.calls === 4");
    assert(sumNone.totals.inputTokens === 100 + 200 + 100 + 100, "totals.inputTokens");
    assert(
      sumNone.totals.outputTokens === 50 + 100 + 50 + 50,
      "totals.outputTokens",
    );
    assert(sumNone.totals.firstAt === NOW - 60 * 86_400_000, "totals.firstAt is the 60d-old row");
    assert(sumNone.totals.lastAt === NOW, "totals.lastAt is the most recent row");

    // 6. summarize(groupBy=model)
    const sumModel = summarize("all", "model");
    log("summarize(all, model)", sumModel);
    assert(sumModel.buckets.length === 2, "2 distinct providers");
    const anthropic = sumModel.buckets.find((b) => b.key.includes("anthropic"));
    const openai = sumModel.buckets.find((b) => b.key.includes("openai"));
    assert(anthropic !== undefined, "anthropic bucket present");
    assert(openai !== undefined, "openai bucket present");
    assert((anthropic?.calls ?? 0) === 3, "anthropic has 3 calls (m1 dedupe → m1 + m2 + old)");
    assert(openai?.calls === 1, "openai has 1 call");

    // 7. summarize(groupBy=session)
    const sumSession = summarize("all", "session");
    log("summarize(all, session)", sumSession);
    assert(sumSession.buckets.length === 2, "2 distinct sessions");
    assert(
      sumSession.buckets.find((b) => b.key === "sess-1")?.calls === 3,
      "sess-1 has 3 calls (m1 dedupe to 1, plus m2 and old)",
    );

    // 8. summarize(groupBy=day) — expects at least 1 bucket
    const sumDay = summarize("all", "day");
    log("summarize(all, day)", sumDay);
    assert(sumDay.buckets.length >= 1, "at least one day bucket");
    assert(/^\d{4}-\d{2}-\d{2}$/.test(sumDay.buckets[0].key), "day key is YYYY-MM-DD");

    // 9. Pagination
    const page1 = listCalls({ range: "all", limit: 2, offset: 0 });
    const page2 = listCalls({ range: "all", limit: 2, offset: 2 });
    log("pagination", { page1Len: page1.rows.length, page2Len: page2.rows.length });
    assert(page1.rows.length === 2, "page1 has 2 rows");
    assert(page2.rows.length === 2, "page2 has 2 rows");
    assert(page1.total === 4 && page2.total === 4, "total stable across pages");
    const ids1 = new Set(page1.rows.map((r) => r.id));
    const ids2 = page2.rows.map((r) => r.id);
    for (const id of ids2) assert(!ids1.has(id), "page2 ids distinct from page1");

    // 10. clearAllData
    const cleared = clearAllData();
    log("clearAllData", cleared);
    assert(cleared.ok === true, "clear returns ok");
    assert(cleared.deleted === 4, "clear reports 4 deleted");
    const afterClear = listCalls({ range: "all", limit: 100, offset: 0 });
    assert(afterClear.total === 0, "all rows gone after clear");

    console.log("\n✓ ALL TESTS PASSED");
  } catch (e) {
    console.error("\n✗ TEST FAILED:", e);
    cleanup();
    process.exit(1);
  } finally {
    cleanup();
  }
})();
