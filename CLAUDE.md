# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## 5. Never Destroy User Data

**Treat any file in a user data directory as irreplaceable until proven otherwise.**

A single careless command can wipe data that has no backup, is not in git, and cannot be recovered. This is not a theoretical risk — it has happened here.

### The hard rules

- **NEVER** run overwrite commands (`cat > file`, `echo > file`, `> file`, `tee file`, `sed -i`, `python3 -c "open(p,'w').write(...)"`) on any file in `~/.pi-web/`, `~/.pi/`, `~/.config/...`, or any other user data directory. These truncate the file before the new content is written; if the new content is malformed, the original is gone with no undo.
- **NEVER** use shell heredoc (`<< EOF ... EOF`) to "create a small test file" at a path that overlaps with a real file. Heredoc + `>` overwrites silently.
- **For tests that need to touch user data**: copy the file to `/tmp/` first, work on the copy, and never write back to the original path. If a test must hit the real file, drive it through the app's own API (POST/PATCH/DELETE) — those code paths are tested and validated.
- **For JSON modification**: use `jq` (in-place with `jq ... file.json > tmp && mv tmp file.json`) or run a Node script. Do not use raw shell redirection.
- **Before any write to user data**: take a backup with `cp file file.bak.$(date +%s)` first. If something goes wrong, restore the backup.

### Why this is so dangerous in this project specifically

- `~/.pi-web/todos.json` is the **only** copy of the user's todo data. It is not git-tracked. There are no automatic backups.
- The `cat > ~/.pi-web/todos.json` idiom is the kind of thing that looks safe in a one-liner test script but truncates the file immediately. If the heredoc body is wrong, the file is `0 bytes` and unrecoverable.
- Other irreplaceable user data in this project: `~/.pi-web/todo_images/`, `~/.pi-web/workspace/`, `~/.pi/agent/sessions/`, `~/.pi/agent/models.json`, `~/.pi-web/pinned.json`.

### If a write goes wrong

1. **Stop.** Do not run more commands. Every subsequent write makes recovery harder.
2. Check if the user's browser app is still open and the React state still has the data. If so, do **not** let them refresh. Have them copy the state out via DevTools (`copy(JSON.stringify(window))` in Console, or React DevTools → TodoProvider state) before anything else.
3. Look for backups in `/tmp/`, `~/.*.bak`, `~/.local/share/Trash/`, the project's `.cache/`, or the running server's memory (`/proc/<pid>/maps` → `heap` region).
4. Only after exhausting recovery options, tell the user what was lost and what remains.

**The cost of "I'll just write a small test file to that path" can be the user's entire data. Don't take that bet.**

# Pi Agent Web

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `node node_modules/.bin/next lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

## Production startup

For long-running local use, do not use `npm run dev`. After source changes,
build the production bundle:

```bash
npm run build
```

Start the production server with:

```bash
/home/alone/.xyl_scripts/run_pi_web.sh
```

---

## Architecture

```
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.pi/agent/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session browsing** (read-only): reads `.jsonl` files directly via `lib/session-reader.ts` — no AgentSession created.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an AgentSession in-process.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/new/route.ts           returns 410 (no longer used)
  agent/new/route.ts              POST { cwd, type, message, toolNames?, provider?, modelId?, thinkingLevel? }
  agent/[id]/route.ts             GET { running, state } | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  files/[...path]/route.ts        GET file contents for viewer
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.pi/agent/models.json

lib/
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  session-reader.ts   parse .jsonl; buildSessionContext, buildTree, path cache
  types.ts            shared TypeScript types
  normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      messages + streaming + SSE + fork/navigate logic
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  ToolPanel.tsx       exports PRESET_NONE/DEFAULT/FULL + getPresetFromTools
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  FileExplorer.tsx    file tree inside sidebar
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called when loading messages from session files (`session-reader.ts`) and when processing streaming events in `ChatWindow`.

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). For existing sessions, the active preset is inferred on mount via `get_tools` → `getPresetFromTools()`. When tools are fully disabled (`toolNames = []`), `rpc-manager.ts` clears `agent.state.systemPrompt` directly.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

---

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```

---

## i18n for Frontend Text

**All user-visible strings in new components must go through i18n — never hardcode display text.**

When adding or modifying frontend components:
- Extract every user-facing string (labels, placeholders, tooltips, aria-labels, status messages, error text) into the i18n dictionary.
- Use the project's existing i18n mechanism (`t('key')` / `useTranslation()`) — don't invent a new pattern.
- Key naming: follow the existing convention (e.g. `namespace.camelCase` or dot-separated). Look at nearby keys before creating new ones.
