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

- The todo list is stored in `~/.pi-web/todos.db` (SQLite via `better-sqlite3`). The legacy `todos.json` was renamed to `todos.json.migrated.<ts>` on first DB read — it is **not** deleted and can be inspected with `cat`. To roll back: run `npx tsx scripts/todos-restore.ts` (writes a fresh `todos.json` from the DB; never overwrites an existing one).
- The `cat > ~/.pi-web/todos.db` (or `todos.json`) idiom is the kind of thing that looks safe in a one-liner test script but truncates the file immediately. If the heredoc body is wrong, the file is `0 bytes` and unrecoverable.
- Other irreplaceable user data in this project: `~/.pi-web/todo_images/`, `~/.pi-web/workspace/`, `~/.pi-web/payloads/`, `~/.pi-web/config.yaml`, `~/.pi/agent/sessions/`, `~/.pi/agent/models.json`, `~/.pi-web/pinned.json`, `~/.pi-web/todo-tools.json`.

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
  sessions/route.ts                 GET  list all sessions (optional ?cwd=)
  sessions/[id]/route.ts            GET/PATCH/DELETE — GET supports ?includeState
  sessions/[id]/context/route.ts    GET ?leafId= — context for a specific leaf
  sessions/[id]/search/route.ts     GET in-session keyword search
  sessions/search/route.ts          GET cross-session keyword search
  agent/new/route.ts                POST { cwd, type, message, toolNames?, provider?, modelId?, thinkingLevel? }
  agent/[id]/route.ts               GET { running, state } | POST any command
  agent/[id]/events/route.ts        GET SSE stream
  agent/[id]/payloads/route.ts      GET captured provider request/response payloads
  files/[...path]/route.ts          GET/PUT/POST/DELETE/PATCH — list/read/watch + write/create/rename/delete
  models/route.ts                   GET { models, modelList, defaultModel, thinkingLevels, thinkingLevelMaps }
  models-config/route.ts            GET/PUT — read/write ~/.pi/agent/models.json
  auth/{providers,all-providers,login/[provider],logout/[provider],api-key/[provider]}
                                    provider auth flows (OAuth login + API-key set/clear)
  context/route.ts                  GET ?cwd= — AGENTS.md files for a cwd (cached 30s)
  create-space/route.ts             POST { dir_name } — mkdir ~/.pi-web/workspace/<dir>
  default-cwd/route.ts              POST — ensure ~/.pi-web/workspace/pi-cwd-default exists
  home/route.ts                     GET { home } — homedir for the UI
  github/contributions/route.ts     GET GitHub contribution heatmap data
  pinned-cwds/route.ts              GET/PUT pinned project list (~/.pi-web/pinned.json)
  pinned-sessions/route.ts          GET/PUT pinned session list
  prompts/route.ts                  GET/POST slash-command prompt templates
  slash-commands/route.ts           GET aggregated slash commands for a cwd
  skills/{route,detail,install,search}
                                    list, inspect, install (npm/git), and search marketplace skills
  settings/route.ts                 GET/PUT — read/write ~/.pi-web/config.yaml
  todos/route.ts                    GET/POST/PATCH/DELETE todos
  todos/[id]/export/route.ts        GET export todo as zip (markdown + images)
  todo-images/route.ts              POST upload image to ~/.pi-web/todo_images/
  todo-images/[filename]/route.ts   GET/DELETE one todo image
  todo-tools/route.ts               GET/PUT enabled-todo-tool config
  weixin/{login,login/verify-code,logout,status,contacts,test-send,inbound,workspace}
                                    WeChat login, contacts, send/receive, push-to-workspace

lib/
  rpc-manager.ts        AgentSessionWrapper + registry + startRpcSession
  session-reader.ts     parse .jsonl; buildSessionContext, buildTree, path cache
  agent-client.ts       sendAgentCommand() — single fetch helper used by hooks
  types.ts              shared frontend types (AgentMessage, SessionEntry, etc.)
  pi-types.ts           narrowed shapes for the pi SDK objects we touch
  normalize.ts          normalizeToolCalls() — field name mismatch between file format and our types
  config.ts             read/write ~/.pi-web/config.yaml (system_prompt_replacements, github_username)
  db.ts                 SQLite handle for ~/.pi-web/todos.db (+ one-shot JSON→DB migration)
  todo-store.ts         CRUD + validation on top of db.ts
  todo-tools.ts         pi customTools that expose the todo store to the agent
  todo-tools-config.ts  read enabled-tool flags from ~/.pi-web/todo-tools.json
  todo-images-utils.ts  helpers for ~/.pi-web/todo_images/
  payload-capture.ts    inline pi-extension hooks → ~/.pi-web/payloads/<sessionId>.jsonl
  json-array-store.ts   read/write a JSON file containing a string array
  file-paths.ts         path normalization + /api/files URL encoding
  file-name.ts          validateFileName() for create/rename routes
  logger.ts             structured logger used by every route + lib file
  npx.ts                helpers to run `npm` / `npx` from the server (skill install)
  fonts/                next/font Inter loader
  wechat/               WeChat client + workspace push utilities

components/
  AppShell.tsx          layout + URL state + tab management
  SessionSidebar.tsx    session tree + FileExplorer
  ChatWindow.tsx        message list + minimap + sticky-scroll wiring
  ChatInput.tsx         input bar + model/thinking/tools/compact controls
  MessageView.tsx       renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx   in-session branch switcher
  ChatMinimap.tsx       scroll minimap alongside the message list
  ToolPanel.tsx         exports PRESET_NONE + getPresetFromTools (only "none" / "full")
  ModelsConfig.tsx      modal for editing ~/.pi/agent/models.json
  SkillsConfig.tsx      modal for installing / browsing / toggling skills
  PromptsConfig.tsx     modal for managing slash-command prompts
  SettingsModal.tsx     modal for ~/.pi-web/config.yaml (replacements, github username)
  PayloadsModal.tsx     modal for inspecting captured provider payloads
  FileExplorer.tsx      file tree inside sidebar
  FileViewer.tsx        file content in a tab (text, image, audio, pdf)
  TabBar.tsx            tab bar (Chat + open file tabs + Todo)
  TodoPanel.tsx         todo list panel
  ToolCallStatsDrawer.tsx  per-tool call statistics for the active turn
  SessionSearch.tsx     in-session and cross-session keyword search UI
  SessionHeatmap.tsx    session activity heatmap
  GithubHeatmap.tsx     GitHub contribution heatmap
  CommandPalette.tsx    ⌘K palette
  ContextMenu.tsx       reusable right-click menu
  ConfirmDialog.tsx     reusable confirm dialog
  Toast.tsx             toast notifications
  Tooltip.tsx           Radix-backed tooltip wrapper
  MarkdownEditor.tsx + MarkdownEditorInner.tsx
                        CodeMirror markdown editor (used in TodoPanel)
  ImageLightbox.tsx     image preview overlay
  FileIcons.tsx         file-type icon set
  WeChatSettingsSection.tsx
                        WeChat login + send-to-workspace settings

hooks/
  useAgentSession.ts    everything chat-window-related: load, stream, fork,
                        navigate, set model/tools/thinking, compact, steer
  useI18n.tsx           en/zh dictionary + locale toggle (t() / useI18n())
  useTheme.ts           CSS theme preset toggle
  useTodos.tsx          todos provider + hook for TodoPanel
  useToolCallStats.ts + ToolCallStatsContext.tsx
                        per-turn tool-call statistics
  useDragDrop.ts        drag-and-drop file/image upload
  useAudio.ts           tone for agent-end notifications
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
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called when loading messages from session files (`session-reader.ts`) and when processing streaming events in `useAgentSession`.

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). `ToolPanel` exports only two presets — `"none"` (empty array) and `"full"` (every tool pi registers at runtime); `PRESET_NONE` is the single named export. When tools are fully disabled (`toolNames = []`), `rpc-manager.ts` clears `agent.state.systemPrompt` directly.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`, plus per-model `thinkingLevels` and `thinkingLevelMaps`. `useAgentSession` pre-selects `defaultModel` on mount for new sessions.

### SSE reconnect on page refresh mid-stream
On `useAgentSession` mount, `GET /api/sessions/[id]?includeState` is called. If `agentState.state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel`, `isCompacting`, and `contextUsage` are also synced from this response.

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

Theme presets (`.theme-default`, `.theme-midnight`, `.theme-synthwave`, `.theme-forest`, …) set these vars; pick from `useTheme`.

```
--bg --bg-panel --bg-hover --bg-selected --bg-subtle --border
--text --text-muted --text-dim
--accent --accent-hover --user-bg --assistant-bg --tool-bg
--font-mono
```

---

## i18n for Frontend Text

**All user-visible strings in new components must go through i18n — never hardcode display text.**

When adding or modifying frontend components:
- Extract every user-facing string (labels, placeholders, tooltips, aria-labels, status messages, error text) into the i18n dictionary at `hooks/useI18n.tsx`.
- Use the project's existing i18n mechanism (`t('key')` from `useI18n()`) — don't invent a new pattern.
- Keys are the English source string itself; add the Chinese translation in the `ZH_TRANSLATIONS` map. Look at nearby keys before creating new ones.
