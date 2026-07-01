/**
 * Smoke test for `lib/http-collections-store.ts`. Runs all CRUD ops against a
 * temp DB (PI_WEB_HTTP_COLLECTIONS_DB env var override), prints results, exits.
 *
 * Usage:  npx tsx scripts/test-http-collections-store.ts
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Override DB path BEFORE importing anything that calls getHttpCollectionsDb.
const tmpDir = mkdtempSync(join(tmpdir(), "http-collections-test-"));
process.env.PI_WEB_HTTP_COLLECTIONS_DB = join(tmpDir, "test.db");

import {
  createCollection,
  createItem,
  deleteCollection,
  deleteItem,
  getItemById,
  listAll,
  updateCollection,
  updateItem,
} from "@/lib/http-collections-store";
import { HttpCollectionNotFoundError, HttpCollectionValidationError } from "@/lib/http-collections-schema";

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

(async () => {
  try {
    // Empty initial state
    const initial = listAll();
    log("initial listAll", initial);
    assert(initial.collections.length === 0, "expected 0 collections initially");
    assert(initial.items.length === 0, "expected 0 items initially");

    // Create a collection
    const c1 = createCollection({ name: "Auth", description: "auth flows" });
    log("created collection", c1);
    assert(c1.name === "Auth", "name roundtrip");
    assert(c1.id.length > 0, "id assigned");

    // Validation: empty name
    try {
      createCollection({ name: "  " });
      assert(false, "empty name should throw");
    } catch (e) {
      assert(
        e instanceof HttpCollectionValidationError,
        "empty name should throw HttpCollectionValidationError",
      );
    }

    // Create another collection
    const c2 = createCollection({ name: "Smoke" });

    // Create an item in c1
    const i1 = createItem({
      name: "Login",
      description: "POST /login",
      method: "POST",
      url: "https://api.example.com/login",
      params: [],
      headers: [
        { id: "h1", key: "Content-Type", value: "application/json", enabled: true },
      ],
      bodyMode: "json",
      body: '{"user":"x"}',
      timeoutMs: 15_000,
      tags: ["auth", "smoke"],
      collectionIds: [c1.id],
    });
    log("created item in c1", i1);
    assert(i1.method === "POST", "method roundtrip");
    assert(i1.headers.length === 1, "headers roundtrip");
    assert(i1.tags.length === 2, "tags roundtrip");

    // Add a 2nd item to c1 + c2 (cross-collection ref → reference model works)
    const i2 = createItem({
      name: "Health",
      method: "GET",
      url: "https://api.example.com/health",
      params: [],
      headers: [],
      bodyMode: "none",
      body: "",
      tags: [],
      collectionIds: [c1.id, c2.id],
    });
    log("created item in c1+c2", i2);

    // listAll: c1 has 2 items, c2 has 1
    const after = listAll();
    log("listAll after creates", after);
    assert(after.collections.length === 2, "2 collections");
    assert(after.items.length === 2, "2 items");
    assert(after.joinRows.length === 3, "3 join rows (2+1)");

    // Update item (rename + change collectionIds)
    const i1Updated = updateItem(i1.id, {
      name: "Login v2",
      collectionIds: [c1.id, c2.id],
    });
    log("updated item", i1Updated);
    assert(i1Updated.name === "Login v2", "rename roundtrip");
    const after2 = listAll();
    assert(after2.joinRows.length === 4, "4 join rows after adding i1 to c2");

    // Update collection description
    const c1Updated = updateCollection(c1.id, { description: "auth flows v2" });
    log("updated collection", c1Updated);
    assert(c1Updated.description === "auth flows v2", "description roundtrip");

    // Delete item (cascades join rows)
    const del = deleteItem(i2.id);
    log("deleted item", del);
    assert(del.unlinkedFrom === 2, "i2 was in 2 collections");
    const after3 = listAll();
    assert(after3.items.length === 1, "1 item remaining");
    assert(after3.joinRows.length === 2, "2 join rows remaining");

    // getItemById
    const fetched = getItemById(i1.id);
    assert(fetched?.name === "Login v2", "getItemById roundtrip");

    // Delete collection (cascades join rows, items untouched)
    const c1Del = deleteCollection(c1.id);
    log("deleted collection", c1Del);
    assert(c1Del.unlinkedFrom >= 1, "c1 had ≥1 join row");
    const after4 = listAll();
    assert(after4.collections.length === 1, "1 collection remaining");
    assert(after4.items.length === 1, "item still exists (D1 semantics)");
    log("after collection delete — items still present", after4);

    // Delete the remaining item
    deleteItem(i1.id);
    const after5 = listAll();
    assert(after5.items.length === 0, "no items remaining");

    // Delete missing collection → not found
    try {
      deleteCollection("does-not-exist");
      assert(false, "should have thrown");
    } catch (e) {
      assert(
        e instanceof HttpCollectionNotFoundError,
        "expected HttpCollectionNotFoundError",
      );
    }

    // Validation: invalid method
    try {
      createItem({
        name: "x",
        method: "FOOBAR" as never,
        url: "https://x",
        params: [],
        headers: [],
        bodyMode: "none",
        body: "",
        collectionIds: [c2.id],
      });
      assert(false, "should have thrown on invalid method");
    } catch (e) {
      assert(
        e instanceof HttpCollectionValidationError,
        "expected validation error on bad method",
      );
    }

    // Validation: empty collectionIds
    try {
      createItem({
        name: "x",
        method: "GET",
        url: "https://x",
        params: [],
        headers: [],
        bodyMode: "none",
        body: "",
        collectionIds: [],
      });
      assert(false, "should have thrown on empty collectionIds");
    } catch (e) {
      assert(
        e instanceof HttpCollectionValidationError,
        "expected validation error on empty collectionIds",
      );
    }

    console.log("\n✓ ALL TESTS PASSED");
  } catch (e) {
    console.error("\n✗ TEST FAILED:", e);
    cleanup();
    process.exit(1);
  } finally {
    cleanup();
  }
})();
