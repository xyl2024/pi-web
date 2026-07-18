/**
 * Smoke test for `lib/todo-tools.ts` (the two pi agent tools) and the
 * supporting helpers in `lib/todo-tools-url.ts` / `lib/todo-images-utils.ts`.
 * Mirrors the runnable-TS pattern of `scripts/test-http-collections-store.ts`:
 *   - mkdtempSync tmp dir
 *   - override PI_WEB_TODOS_DB BEFORE importing anything that calls getDb()
 *   - assertion failures exit(1); cleanup runs in `finally`
 *
 * The tests deliberately call the exported pure helpers
 * (`buildListPayload`, `buildDescriptionPayload`, etc.) instead of
 * `tool.execute(toolCallId, params, signal, onUpdate, ctx)` — the SDK
 * requires a real `ExtensionContext` for `ctx`, which is overkill for
 * unit-testing the data shape. The `execute` wrappers in lib/todo-tools.ts
 * are thin adapters over these pure functions.
 *
 * Usage:  npx tsx scripts/test-todo-tools.ts
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Override DB path BEFORE importing anything that calls getDb().
const tmpDir = mkdtempSync(join(tmpdir(), "todo-tools-test-"));
process.env.PI_WEB_TODOS_DB = join(tmpDir, "test.db");

import {
  TODO_TOOL_NAMES,
  buildDescriptionEchoText,
  buildDescriptionPayload,
  buildListPayload,
} from "@/lib/todo-tools-payloads";
import { createTodo, getTodoById, listTodos, updateTodo, type Todo } from "@/lib/todo-store";
import { getDb } from "@/lib/db";
import {
  __resetTodoImageBaseUrlForTests,
  getTodoImageBaseUrl,
  todoImageUrl,
} from "@/lib/todo-tools-url";
import {
  TODO_IMAGE_FILENAME_RE,
  extractTodoImageFilenames,
  mimeForTodoImageFilename,
} from "@/lib/todo-images-utils";

function log(label: string, value: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
}

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) return;
  failures++;
  console.error(`ASSERT FAILED: ${msg}`);
}

function cleanup(): void {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Section 1: getTodoImageBaseUrl
// ---------------------------------------------------------------------------

function testBaseUrl(): void {
  console.log("\n=== getTodoImageBaseUrl ===");

  delete process.env.PI_WEB_PUBLIC_BASE_URL;
  delete process.env.NEXTAUTH_URL;
  delete process.env.BASE_URL;
  process.env.PORT = "12345";
  __resetTodoImageBaseUrlForTests();
  const r1 = getTodoImageBaseUrl();
  assert(r1 === "http://localhost:12345", `PORT=12345 → http://localhost:12345, got ${r1}`);

  delete process.env.PORT;
  __resetTodoImageBaseUrlForTests();
  const r2 = getTodoImageBaseUrl();
  assert(r2 === "http://localhost:30141", `no PORT → http://localhost:30141, got ${r2}`);

  process.env.PI_WEB_PUBLIC_BASE_URL = "https://x.example.com/";
  __resetTodoImageBaseUrlForTests();
  const r3 = getTodoImageBaseUrl();
  assert(r3 === "https://x.example.com", `PI_WEB_PUBLIC_BASE_URL trailing slash stripped, got ${r3}`);

  process.env.PI_WEB_PUBLIC_BASE_URL = "not a url";
  __resetTodoImageBaseUrlForTests();
  const r4 = getTodoImageBaseUrl();
  assert(r4 === "http://localhost:30141", `malformed PI_WEB_PUBLIC_BASE_URL falls through, got ${r4}`);

  process.env.PI_WEB_PUBLIC_BASE_URL = "https://y.example.com";
  process.env.NEXTAUTH_URL = "https://z.example.com";
  __resetTodoImageBaseUrlForTests();
  const r5 = getTodoImageBaseUrl();
  assert(r5 === "https://y.example.com", `PI_WEB_PUBLIC_BASE_URL beats NEXTAUTH_URL, got ${r5}`);

  delete process.env.PI_WEB_PUBLIC_BASE_URL;
  __resetTodoImageBaseUrlForTests();
  const r6 = getTodoImageBaseUrl();
  assert(r6 === "https://z.example.com", `NEXTAUTH_URL beats BASE_URL/PORT, got ${r6}`);

  // restore default for subsequent sections
  delete process.env.NEXTAUTH_URL;
  delete process.env.BASE_URL;
  process.env.PORT = "30141";
  __resetTodoImageBaseUrlForTests();
}

// ---------------------------------------------------------------------------
// Section 2: mimeForTodoImageFilename
// ---------------------------------------------------------------------------

function testMime(): void {
  console.log("\n=== mimeForTodoImageFilename ===");

  assert(mimeForTodoImageFilename("a.png") === "image/png", `png → image/png`);
  assert(mimeForTodoImageFilename("a.PNG") === "image/png", `PNG case-insensitive`);
  assert(mimeForTodoImageFilename("a.jpeg") === "image/jpeg", `jpeg → image/jpeg`);
  assert(mimeForTodoImageFilename("a.bmp") === "image/bmp", `bmp → image/bmp`);
  assert(mimeForTodoImageFilename("a.svg") === "image/svg+xml", `svg → image/svg+xml`);
  assert(mimeForTodoImageFilename("a.xyz") === "application/octet-stream", `unknown ext → octet-stream`);
  assert(mimeForTodoImageFilename("noext") === "application/octet-stream", `no ext → octet-stream`);
  assert(mimeForTodoImageFilename("trailing.") === "application/octet-stream", `trailing dot → octet-stream`);
}

// ---------------------------------------------------------------------------
// Section 3: extractTodoImageFilenames
// ---------------------------------------------------------------------------

function testExtract(): void {
  console.log("\n=== extractTodoImageFilenames ===");

  const validUuid1 = "12345678-1234-1234-1234-123456789abc";
  const validUuid2 = "abcdef01-2345-6789-abcd-ef0123456789";
  const desc = [
    `Hello world`,
    `![diagram](/api/todo-images/${validUuid1}.png)`,
    `Some text`,
    `![photo](/api/todo-images/${validUuid2}.jpg "caption")`,
    `![bad](/api/todo-images/../etc/passwd.png)`,
    `![dup](/api/todo-images/${validUuid1}.png)`,
  ].join("\n");

  const filenames = extractTodoImageFilenames(desc);
  assert(filenames.length === 2, `deduped to 2 valid refs, got ${filenames.length}`);
  assert(filenames[0] === `${validUuid1}.png`, `first ref is ${validUuid1}.png, got ${filenames[0]}`);
  assert(filenames[1] === `${validUuid2}.jpg`, `second ref is ${validUuid2}.jpg, got ${filenames[1]}`);
}

// ---------------------------------------------------------------------------
// Section 4: listTodos filtering (with seeded data)
// ---------------------------------------------------------------------------

// Seed: 6 todos covering every filter dimension. createdAt ordering is
// T0 < T1 < T2 < T3 < T4 < T5. Deadlines are relative to a `now` we control.
const NOW = Date.UTC(2026, 6, 18, 12, 0, 0); // 2026-07-18T12:00:00Z
const T0 = NOW - 5 * 86_400_000;
const T1 = NOW - 4 * 86_400_000;
const T2 = NOW - 3 * 86_400_000;
const T3 = NOW - 2 * 86_400_000;
const T4 = NOW - 1 * 86_400_000;
const T5 = NOW;
const D_NEG = NOW - 86_400_000;
const D_POS_1 = NOW + 86_400_000;
const D_POS_2 = NOW + 2 * 86_400_000;
const D_POS_5 = NOW + 5 * 86_400_000;

interface SeededIds {
  t1: string;
  t2: string;
  t3: string;
  t4: string;
  t5: string;
  t6: string;
}

function seedTodos(): SeededIds {
  const t1 = createTodo("", { title: "active A d1", deadline: D_POS_1, tags: ["A"] }).id;
  const t2 = createTodo("", { title: "active B d2", deadline: D_POS_2, tags: ["B"] }).id;
  const t3 = createTodo("", { title: "active AB nodl", tags: ["A", "B"] }).id;
  const t4Raw = createTodo("", { title: "done nodl", deadline: D_NEG, tags: [] });
  const t4Done = updateTodo("", t4Raw.id, { done: true });
  const t5Raw = createTodo("", { title: "done A", tags: ["A"] });
  const t5Done = updateTodo("", t5Raw.id, { done: true });
  const t6 = createTodo("", { title: "active B d5", deadline: D_POS_5, tags: ["B"] }).id;

  // Force createdAt to deterministic values via raw UPDATE; createTodo
  // stamps Date.now() which we can't override without monkey-patching.
  const stmt = getDb().prepare(`UPDATE todos SET created_at = ? WHERE id = ?`);
  stmt.run(T0, t4Done.id);
  stmt.run(T1, t1);
  stmt.run(T2, t2);
  stmt.run(T3, t3);
  stmt.run(T4, t5Done.id);
  stmt.run(T5, t6);
  return { t1, t2, t3, t4: t4Done.id, t5: t5Done.id, t6 };
}

function testListFiltering(ids: SeededIds): void {
  console.log("\n=== listTodos filtering ===");

  const all = listTodos("", { now: NOW, limit: 1000 });
  log("seeded todos", all.map((t) => ({ id: t.id, title: t.title, done: t.done, deadline: t.deadline, createdAt: t.createdAt, tags: t.tags.map((x) => x.name) })));
  assert(all.length === 6, `seeded 6 todos, got ${all.length}`);

  // createdAfter is inclusive: ≥ T2 → t2,t3,t5,t6
  const afterT2 = listTodos("", { now: NOW, createdAfter: T2, limit: 1000 });
  assert(afterT2.length === 4, `createdAfter=T2 → 4, got ${afterT2.length}`);

  // createdBefore is exclusive: < T2 → t1, t4
  const beforeT2 = listTodos("", { now: NOW, createdBefore: T2, limit: 1000 });
  assert(beforeT2.length === 2, `createdBefore=T2 → 2, got ${beforeT2.length}`);

  // deadlineAfter is inclusive: ≥ D_POS_2 → t2 (D_POS_2 == D_POS_2) and
  // t6 (D_POS_5 > D_POS_2). Todos without a deadline are excluded.
  const afterDP2 = listTodos("", { now: NOW, deadlineAfter: D_POS_2, limit: 1000 });
  assert(afterDP2.length === 2, `deadlineAfter=D_POS_2 → 2 (t2 + t6), got ${afterDP2.length}`);
  const afterIds = afterDP2.map((t) => t.id).sort();
  const expectedAfterIds = [ids.t2, ids.t6].sort();
  assert(JSON.stringify(afterIds) === JSON.stringify(expectedAfterIds),
    `deadlineAfter returns [t2, t6], got ${JSON.stringify(afterIds)}`);

  // tags: ["A"] → t1, t3, t5 (3)
  const tagA = listTodos("", { now: NOW, tags: ["A"], limit: 1000 });
  assert(tagA.length === 3, `tags=[A] → 3, got ${tagA.length}`);

  // tags: ["A","B"] OR → t1, t2, t3, t5, t6 (5)
  const tagAB = listTodos("", { now: NOW, tags: ["A", "B"], limit: 1000 });
  assert(tagAB.length === 5, `tags=[A,B] → 5, got ${tagAB.length}`);

  // done === true → t4, t5 (2)
  const doneOnly = listTodos("", { now: NOW, done: true, limit: 1000 });
  assert(doneOnly.length === 2, `done:true → 2, got ${doneOnly.length}`);

  // done === false → t1, t2, t3, t6 (4)
  const activeOnly = listTodos("", { now: NOW, done: false, limit: 1000 });
  assert(activeOnly.length === 4, `done:false → 4, got ${activeOnly.length}`);

  // active sort: deadline asc, undefined last. Expected order: t1 (D_POS_1),
  // t2 (D_POS_2), t6 (D_POS_5), t3 (no deadline).
  const activeIds = activeOnly.map((t) => t.id);
  assert(activeIds[0] === ids.t1, `active[0] is t1, got ${activeIds[0]}`);
  assert(activeIds[1] === ids.t2, `active[1] is t2, got ${activeIds[1]}`);
  assert(activeIds[2] === ids.t6, `active[2] is t6, got ${activeIds[2]}`);
  assert(activeIds[3] === ids.t3, `active[3] is t3 (no deadline, last), got ${activeIds[3]}`);

  // combined: done + tags:[A]
  const doneWithA = listTodos("", { now: NOW, done: true, tags: ["A"], limit: 1000 });
  assert(doneWithA.length === 1, `done + tags:[A] → 1 (t5), got ${doneWithA.length}`);

  // window exclusive upper: createdBefore T1 → only t4 (T0)
  const beforeT1 = listTodos("", { now: NOW, createdBefore: T1, limit: 1000 });
  assert(beforeT1.length === 1, `createdBefore=T1 → 1, got ${beforeT1.length}`);
}

// ---------------------------------------------------------------------------
// Section 5: buildListPayload (the pure backing for userTodosListTool)
// ---------------------------------------------------------------------------

function testListPayload(): void {
  console.log("\n=== buildListPayload ===");

  const all = buildListPayload({}, () => NOW);
  log("buildListPayload no filters", all.details);
  assert(all.details.total === 6, `total=6, got ${all.details.total}`);
  assert(all.details.returned === 6, `returned=6, got ${all.details.returned}`);
  assert(all.details.truncated === false, `truncated=false`);
  assert(all.details.todos.length === 6, `todos.length=6, got ${all.details.todos.length}`);

  // No description on any item
  for (const item of all.details.todos) {
    assert(
      !("description" in item) || item.description === undefined,
      `no description on item ${item.id}`,
    );
    assert(typeof item.id === "string" && item.id.length > 0, `id is non-empty string`);
    assert(item.todo_name.length > 0, `todo_name non-empty`);
    assert(item.status === "done" || item.status === "processing", `status is done|processing`);
    assert(typeof item.create_time === "number", `create_time is number`);
  }

  // status: processing → only 4
  const processing = buildListPayload({ status: "processing" }, () => NOW);
  assert(processing.details.total === 4, `processing total=4, got ${processing.details.total}`);
  assert(processing.details.todos.every((x) => x.status === "processing"), `all status=processing`);

  // status: done → only 2
  const done = buildListPayload({ status: "done" }, () => NOW);
  assert(done.details.total === 2, `done total=2, got ${done.details.total}`);
  assert(done.details.todos.every((x) => x.status === "done"), `all status=done`);

  // limit → truncated
  const limited = buildListPayload({ status: "processing", limit: 2 }, () => NOW);
  assert(limited.details.total === 4, `processing+limit total=4`);
  assert(limited.details.returned === 2, `processing+limit returned=2`);
  assert(limited.details.truncated === true, `processing+limit truncated=true`);

  // tags OR
  const tagAB = buildListPayload({ tags: ["A", "B"] }, () => NOW);
  assert(tagAB.details.total === 5, `tags [A,B] → 5, got ${tagAB.details.total}`);

  // create_time_window + due_time_window
  const windowed = buildListPayload(
    {
      create_time_window: { start: T2, end: T5 },
      due_time_window: { start: D_POS_2 },
    },
    () => NOW,
  );
  // createdAt ∈ [T2, T5) → t2 (T2), t3 (T3), t4 (T4). t5 (T4 done) also fits
  // by createdAt but is in the done group; deadlineAfter=D_POS_2 includes
  // t2 (deadline=D_POS_2) and t6 (deadline=D_POS_5). Intersect: t2 only.
  assert(windowed.details.total === 1, `windows intersect → 1 (t2), got ${windowed.details.total}`);

  // TODO_TOOL_NAMES contains both new names
  assert(TODO_TOOL_NAMES.length === 2, `TODO_TOOL_NAMES.length=2, got ${TODO_TOOL_NAMES.length}`);
  assert(
    (TODO_TOOL_NAMES as readonly string[]).includes("user_todos_list"),
    `TODO_TOOL_NAMES includes user_todos_list`,
  );
  assert(
    (TODO_TOOL_NAMES as readonly string[]).includes("user_todo_description"),
    `TODO_TOOL_NAMES includes user_todo_description`,
  );
  assert(
    !(TODO_TOOL_NAMES as readonly string[]).includes("todo_list"),
    `TODO_TOOL_NAMES no longer includes todo_list`,
  );

  // text contains header
  assert(all.text.startsWith("6 todo(s):"), `text starts with count header, got "${all.text.slice(0, 30)}"`);
  // Each line in body has [id=...]
  const bodyLines = all.text.split("\n").slice(1).filter((l) => l.length > 0);
  assert(bodyLines.length === 6, `text body has 6 lines`);
  for (const line of bodyLines) {
    assert(/\[id=[0-9a-f-]{36}\]/.test(line), `line contains [id=...]: "${line}"`);
  }
}

// ---------------------------------------------------------------------------
// Section 6: buildDescriptionPayload / buildDescriptionEchoText
// ---------------------------------------------------------------------------

function testDescriptionPayload(): void {
  console.log("\n=== buildDescriptionPayload ===");

  const uuid = "12345678-1234-1234-1234-123456789abc";
  const uuid2 = "abcdef01-2345-6789-abcd-ef0123456789";
  const badUuid = "../../etc/passwd";
  const desc = [
    `Some description text.`,
    ``,
    `![diagram](/api/todo-images/${uuid}.png)`,
    `![photo](/api/todo-images/${uuid2}.jpg "caption")`,
    `![bad](/api/todo-images/${badUuid}.png)`, // filtered out
  ].join("\n");

  const created = createTodo("", {
    title: "test todo with images",
    description: desc,
    tags: ["x"],
  });

  // Force origin so url is deterministic.
  process.env.PI_WEB_PUBLIC_BASE_URL = "https://example.test";
  __resetTodoImageBaseUrlForTests();

  const fetched: Todo | undefined = getTodoById(created.id);
  if (!fetched) {
    assert(false, `getTodoById returned undefined for just-created todo`);
    return;
  }
  const payload = buildDescriptionPayload(fetched);
  log("buildDescriptionPayload", payload);
  assert(payload.id === created.id, `payload.id matches`);
  assert(payload.content === desc, `payload.content equals the stored description`);
  assert(payload.images.length === 2, `2 valid images extracted (1 filtered), got ${payload.images.length}`);
  assert(payload.images[0]?.filename === `${uuid}.png`, `image[0].filename is ${uuid}.png`);
  assert(payload.images[0]?.url === `https://example.test/api/todo-images/${uuid}.png`, `image[0].url is absolute https, got ${payload.images[0]?.url}`);
  assert(payload.images[0]?.mime === "image/png", `image[0].mime is image/png`);
  assert(payload.images[1]?.filename === `${uuid2}.jpg`, `image[1].filename is ${uuid2}.jpg`);
  assert(payload.images[1]?.mime === "image/jpeg", `image[1].mime is image/jpeg`);

  // todoImageUrl unit
  assert(
    todoImageUrl(`${uuid}.png`) === `https://example.test/api/todo-images/${uuid}.png`,
    `todoImageUrl returns absolute URL`,
  );

  // Echo text
  const echo = buildDescriptionEchoText(fetched, payload);
  assert(echo.includes(`[id=${created.id}]`), `echo contains id`);
  assert(echo.includes(`(2 images)`), `echo shows 2 images count, got: "${echo.split("\n")[0]}"`);
  assert(echo.includes(desc), `echo contains description text`);

  // Empty description → "(description is empty)"
  const empty = createTodo("", { title: "empty desc" });
  const emptyTodo = getTodoById(empty.id);
  if (!emptyTodo) {
    assert(false, `getTodoById undefined for empty todo`);
    return;
  }
  const emptyPayload = buildDescriptionPayload(emptyTodo);
  assert(emptyPayload.content === "", `empty content, got "${emptyPayload.content}"`);
  assert(emptyPayload.images.length === 0, `no images, got ${emptyPayload.images.length}`);
  const emptyEcho = buildDescriptionEchoText(emptyTodo, emptyPayload);
  assert(emptyEcho.includes("(description is empty)"), `empty echo has placeholder, got "${emptyEcho}"`);

  // not_found path: getTodoById returns undefined → caller (execute wrapper)
  // is responsible for emitting the error result. Verify the lookup path.
  const missingTodo = getTodoById("does-not-exist");
  assert(missingTodo === undefined, `unknown id → undefined`);

  // Restore default origin
  delete process.env.PI_WEB_PUBLIC_BASE_URL;
  __resetTodoImageBaseUrlForTests();
}

// ---------------------------------------------------------------------------
// Section 7: TODO_IMAGE_FILENAME_RE
// ---------------------------------------------------------------------------

function testFilenameRegex(): void {
  console.log("\n=== TODO_IMAGE_FILENAME_RE ===");
  assert(TODO_IMAGE_FILENAME_RE.test(`12345678-1234-1234-1234-123456789abc.png`), `valid uuid.png passes`);
  assert(!TODO_IMAGE_FILENAME_RE.test(`../../etc/passwd`), `path traversal rejected`);
  assert(!TODO_IMAGE_FILENAME_RE.test(`abc.png`), `non-uuid rejected`);
  assert(!TODO_IMAGE_FILENAME_RE.test(`12345678-1234-1234-1234-123456789abc.exe`), `unknown ext rejected`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  try {
    testBaseUrl();
    testMime();
    testExtract();
    // Seed once, share between the two filtering sections.
    const seeded = seedTodos();
    testListFiltering(seeded);
    testListPayload();
    testDescriptionPayload();
    testFilenameRegex();

    if (failures > 0) {
      console.error(`\n✗ ${failures} ASSERTION(S) FAILED`);
      cleanup();
      process.exit(1);
    }
    console.log("\n✓ ALL TESTS PASSED");
  } catch (e) {
    console.error("\n✗ TEST CRASHED:", e);
    failures = failures || 1;
  } finally {
    cleanup();
  }
  if (failures > 0) process.exit(1);
}

main();