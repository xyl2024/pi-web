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

- The user todo list is stored in `~/.pi-web/todos.db` (SQLite via `better-sqlite3`). The legacy `todos.json` was renamed to `todos.json.migrated.<ts>` on first DB read — it is **not** deleted and can be inspected with `cat`. To roll back: run `npx tsx scripts/todos-restore.ts` (writes a fresh `todos.json` from the DB; if `--out` already exists it is renamed to `<out>.restored.<ts>` first, matching the rename-not-delete migration pattern).
- The `cat > ~/.pi-web/todos.db` (or `todos.json`) idiom is the kind of thing that looks safe in a one-liner test script but truncates the file immediately. If the heredoc body is wrong, the file is `0 bytes` and unrecoverable.
- Other irreplaceable user data in this project: `~/.pi-web/todo_images/`, `~/.pi-web/workspace/`, `~/.pi-web/payloads/`, `~/.pi-web/config.yaml`, `~/.pi-web/scheduler.db`, `~/.pi-web/http-collections.db`, `~/.pi-web/favorites.json`, `~/.pi-web/agent-todo/`, `~/.pi/agent/sessions/`, `~/.pi/agent/models.json`, `~/.pi-web/pinned.json`, `~/.pi-web/todo-tools.json`.
- The agent todo state lives in `~/.pi-web/agent-todo/<sessionId>.jsonl` (append-only snapshots). The current state is the last parsed line; truncating the file wipes it instantly with no DB backup.

### If a write goes wrong

1. **Stop.** Do not run more commands. Every subsequent write makes recovery harder.
2. Check if the user's browser app is still open and the React state still has the data. If so, do **not** let them refresh. Have them copy the state out via DevTools (`copy(JSON.stringify(window))` in Console, or React DevTools → TodoProvider state) before anything else.
3. Look for backups in `/tmp/`, `~/.*.bak`, `~/.local/share/Trash/`, the project's `.cache/`, or the running server's memory (`/proc/<pid>/maps` → `heap` region).
4. Only after exhausting recovery options, tell the user what was lost and what remains.

**The cost of "I'll just write a small test file to that path" can be the user's entire data. Don't take that bet.**

# Pi Work

Web UI for the pi coding agent. The product is called "Pi Work" (renamed from "Pi Agent Web"). The package is `@agegr/pi-web`.

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`
Lint: `npm run lint` (= `eslint .`, the `next lint` subcommand was removed in Next 16)
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

## Electron shell (optional desktop wrapper)

`electron-shell/` ships a small Electron app that embeds the running Pi Work
in an `<iframe>` with a custom macOS-style traffic-light titlebar. It expects
the server on `PI_PORT` (default `14514`) and connects to `http://localhost:<port>`.

- The iframe must declare `allow="clipboard-read; clipboard-write"` or the
  Chromium Permissions-Policy will silently block every
  `navigator.clipboard.writeText()` call inside Pi Work.
- DevTools toggle: F12 / Ctrl+Shift+I (handled in `titlebar.js`).
- Tray icon + global shortcut + `--hidden` flag are part of the Phase 1 scope
  in `main.js`; see that file for current behavior.

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

### Process startup

`instrumentation.ts` runs once per server boot. It lazily imports the WeChat
monitor bootstrap, the scheduler loop bootstrap, and the RSS poll-loop
bootstrap, so a logged-in WeChat account, any enabled cron tasks, and any
configured RSS feeds start being serviced as soon as the server is up — no
need to load any page first.

### Right-panel architecture

The right side of `AppShell` hosts a stack of tool panels, each backed by a
module-scoped store using `useSyncExternalStore`:

- `sessionUiStore` — branch leaf (`branchTree`/`ActiveLeafId`), `systemPrompt`, `agentsFiles`, `sessionStats`, `contextUsage`. Owned by `useAgentSession`, read by `AppShell`. Imperative session controls (model/thinking/tools/compact/steer) are bridged to `CommandPalette` ⌘K via the separate `useAgentControls()` hook, **not** part of this store's snapshot.
- `toolCallStatsStore` — per-turn tool call statistics, owned by `useAgentSession`, read by the vertical button + `ToolCallStatsPanel`.
- `httpStore` — HTTP debug-panel draft state; survives tab switches and panel closes (no disk persistence, by design).

The store pattern eliminates the previous "5 separate `onXxxChange` props +
matching `useState` in AppShell" dance and makes state survive `ChatWindow`
remounts (no top-bar flash on session switches).

### Custom command palette

`lib/commands.tsx` defines a typed command registry (each command has an SVG
icon, keybinding, predicate, and run function). `CommandPalette` (⌘K,
Raycast-style) is wired into `AppShell` and reads + dispatches agent
controls registered by the active `ChatWindow` via `setAgentControls()`. New
agent-facing actions belong here rather than as ad-hoc top-bar buttons.

### HTTP debug panel + request collections

`HttpPanel` posts to `/api/http` (server-side `proxyFetch` in `lib/http-proxy.ts`),
which streams the response back with size + timeout guards. A client-supplied
`id` registers an `AbortController` on `globalThis.__piHttpInFlight` so the
`POST /api/http/[id]/cancel` route can abort it.

`HttpPanelCollections` (drawer) persists reusable requests in
`~/.pi-web/http-collections.db` via `lib/http-collections-store.ts`. The
contract is in `lib/http-collections-schema.ts`; the validation error class
mirrors `TodoValidationError` so the route layer can map domain errors to
HTTP statuses uniformly.

### Scheduler

Cron-based task runner in `lib/scheduler/`. The loop (self-rescheduling
`setTimeout`, no `setInterval` drift) is started by `lib/scheduler/startup.ts`
from `instrumentation.ts`. Every CRUD on `/api/scheduled-tasks` calls
`reschedule()` so the loop picks up changes immediately. Each run cold-starts
a fresh pi session (the scheduler never shares a wrapper with a user's open
session) and records `{ running, success, error, timeout }` outcomes to
`scheduled_task_runs`.

### Permission dialog

`PermissionProvider` (in `hooks/usePendingPermissions.tsx`) listens for
inbound permission requests from the SSE stream and renders a portal'd
`PermissionDialog` with **Esc → deny**, **Enter → allow once**, and
backdrop-click → deny as the safe defaults. Decisions are POSTed back to the
session; queue is mirrored in a `useRef` so async handlers always see the
latest list when removing by `toolCallId`.

### Custom agent tools

`lib/rpc-manager.ts` registers these as `customTools` on `createAgentSession`:

- `todo_list` / `todo_create` / `todo_update` / `todo_delete` — CRUD against `~/.pi-web/todos.db` (`lib/todo-tools.ts`, gated by `~/.pi-web/todo-tools.json`).
- `show_file` — inline-render one or more files below the tool call in chat (`lib/show-file-tool.ts` + `lib/show-file-tool-types.ts`). Path validation reuses `lib/file-access.ts` (same allowed roots as `/api/files`).
- `agent_todo` — single-tool action-dispatched (`create | update | list | get | delete | clear`); persisted per-session to `~/.pi-web/agent-todo/<sessionId>.jsonl` as append-only snapshots (`lib/agent-todo-store.ts`). Full design in `docs/agent-todo/`.

Server-only files (`*-tool.ts`, `*-store.ts` under `lib/`) import `@earendil-works/pi-coding-agent`, which transitively pulls in `child_process` and other Node modules. **Client code must import types/constants from the matching `-types.ts` file instead** — see the `IMPORTANT` comment at the top of each tool file.

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
  agent/[id]/agent-todo/route.ts    GET current task state + historyCount for one session
  files/[...path]/route.ts          GET/PUT/POST/DELETE/PATCH — list/read/watch + write/create/rename/delete
  models/route.ts                   GET { models, modelList, defaultModel, thinkingLevels, thinkingLevelMaps }
  models-config/route.ts            GET/PUT — read/write ~/.pi/agent/models.json
  auth/{providers,all-providers,login/[provider],logout/[provider],api-key/[provider]}
                                    provider auth flows (OAuth login + API-key set/clear)
  context/route.ts                  GET ?cwd= — AGENTS.md files for a cwd (cached 30s)
  create-space/route.ts             POST { dir_name } — mkdir ~/.pi-web/workspace/<dir>
  default-cwd/route.ts              POST — ensure ~/.pi-web/workspace/pi-cwd-default exists
  home/route.ts                     GET { home } — homedir for the UI
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
  tags/route.ts                     PATCH rename / DELETE remove a tag globally
  tags/color/route.ts               PATCH set or clear a tag's color
  http/route.ts                     POST { id, method, url, ... } — server-side proxyFetch
  http/[id]/cancel/route.ts         POST cancel an in-flight HTTP request
  http-collections/route.ts         GET full snapshot of collections + items
  http-collections/collections/{route,[id]/route.ts}
                                    POST create / GET-PUT-DELETE /[id] edit or delete one collection
  http-collections/items/{route,[id]/route.ts}
                                    POST create / GET-PUT-DELETE /[id] one saved request item
  scheduled-tasks/route.ts          GET/POST/PATCH/DELETE scheduled cron tasks
  scheduled-tasks/[id]/run/route.ts POST run a task now (ad-hoc)
  scheduled-tasks/[id]/runs/route.ts GET last N runs for one task
  scheduled-tasks/[id]/runs/mark-all-read/route.ts POST mark all runs as read
  scheduled-tasks/runs/[runId]/route.ts GET one run detail
  favorites/route.ts                GET/PUT pinned session list (~/.pi-web/favorites.json)
  translate/route.ts                POST { text, provider, modelId, target } — in-memory LLM call, no disk
  weixin/{login,login/verify-code,logout,status,contacts,test-send,inbound,workspace}
                                    WeChat login, contacts, send/receive, push-to-workspace
  finance/{route,[id]/route,export/route}.ts
                                    CRUD + zip export for the finance ledger (~/.pi-web/finance.db)
  notes/{route,notes-tags/{route,color/route}}.ts + note-images/{route,[filename]/route}.ts
                                    notes CRUD, tag rename/color, image upload/serve
  rss/{feeds/{route,[id]/route,[id]/articles/route},articles/{[id]/route,mark-all-read/route},fetch/route}.ts
                                    RSS feed CRUD + article list/fetch + bulk read state

lib/
  rpc-manager.ts            AgentSessionWrapper + registry + startRpcSession; customTools registration
  session-reader.ts         parse .jsonl; buildSessionContext, buildTree, path cache
  agent-client.ts           sendAgentCommand() — single fetch helper used by hooks
  types.ts                  shared frontend types (AgentMessage, SessionEntry, etc.)
  pi-types.ts               narrowed shapes for the pi SDK objects we touch
  normalize.ts              normalizeToolCalls() — field name mismatch between file format and our types
  config.ts                 read/write ~/.pi-web/config.yaml (system_prompt_replacements, dangerous_patterns)
  db.ts                     SQLite handle for ~/.pi-web/todos.db (+ one-shot JSON→DB migration)
  todo-store.ts             CRUD + validation on top of db.ts
  todo-tools.ts             pi customTools that expose the todo store to the agent
  todo-tools-config.ts      read enabled-tool flags from ~/.pi-web/todo-tools.json
  todo-images-utils.ts      helpers for ~/.pi-web/todo_images/
  todo-image-upload.ts      server-side image upload helper
  todo-color-presets.ts     shared palette for tag chips + Tiptap text color
  description-sanitize.ts   single DOMPurify config shared by every code path that touches todo descriptions
  payload-capture.ts        inline pi-extension hooks → ~/.pi-web/payloads/<sessionId>.jsonl
  json-array-store.ts       read/write a JSON file containing a string array
  file-paths.ts             path normalization + /api/files URL encoding
  file-name.ts              validateFileName() for create/rename routes
  file-access.ts            shared allowed-roots logic for /api/files + show_file tool (cached 5s)
  logger.ts                 structured logger used by every route + lib file
  npx.ts                    helpers to run `npm` / `npx` from the server (skill install)
  shallowEqual.ts           content-equality guard used by every useSyncExternalStore store
  dangerous-patterns.ts     compile + cache regex rules from config.dangerous_patterns
  commands.tsx              command-palette registry: typed commands + AgentControls bridge
  agent-todo-tool.ts        server-side: pi customTool wrapping lib/agent-todo-tool/{reducer,invariants,response-envelope}
  agent-todo-tool-types.ts  client-safe types/constants (no pi SDK import)
  agent-todo-tool/          reducer.ts (pure) + invariants.ts + response-envelope.ts
  agent-todo-store.ts       per-session JSONL persistence (~/.pi-web/agent-todo/<sid>.jsonl)
  useAgentTodo is the client read-side hook
  show-file-tool.ts         server-side: pi customTool for inline file rendering
  show-file-tool-types.ts   client-safe types/constants
  canvas-files-store.ts     IndexedDB storage for Excalidraw image dataURLs (with orphan GC)
  translate.ts              shared translate prompts + language list (server + client)
  curl-parser.ts            best-effort cURL command parser for the HTTP panel
  json-parser.ts            tolerant JSON parser for the JSON panel
  http-proxy.ts             proxyFetch core + in-flight AbortController registry
  http-collections-db.ts    SQLite handle for ~/.pi-web/http-collections.db
  http-collections-schema.ts types + validation + error classes for the collections feature
  http-collections-store.ts CRUD on top of the DB
  scheduler-db.ts           SQLite handle for ~/.pi-web/scheduler.db
  scheduler-store.ts        CRUD + validation for scheduled tasks + runs
  scheduler/                loop.ts (self-rescheduling setTimeout) + runner.ts (per-task FIFO chain)
                            + startup.ts (instrumentation bootstrap)
  wechat/                   WeChat client + workspace push utilities + inbound monitor + state
  fonts/                    vendored LXGW WenKai webfonts (woff2, subsetted) + OFL + README
  finance-{db,schema,store,preset-categories}.ts + notes-{db,store} + rss-{db,schema,sanitize,store}.ts
                                    DB handles + validation + CRUD for the three side features
  note-image-upload.ts + rss/{loop,startup}.ts  one-shot image upload + self-rescheduling RSS poll loop

components/
  AppShell.tsx              layout + URL state + tab management + right-panel stack
  SessionSidebar.tsx        session tree + FileExplorer + favorites
  ChatWindow.tsx            message list + minimap + sticky-scroll wiring
  ChatInput.tsx             input bar + model/thinking/tools/compact controls + new-session button
  MessageView.tsx           renders one message (user/assistant/toolCall/toolResult/show_file)
  BranchNavigator.tsx       in-session branch switcher
  ChatMinimap.tsx           scroll minimap alongside the message list
  ToolPanel.tsx             exports `PRESET_NONE` (the only named preset constant; `getPresetFromTools` returns "none" / "full" only)
  ModelsConfig.tsx          modal for editing ~/.pi/agent/models.json
  SkillsConfig.tsx          modal for installing / browsing / toggling skills
  PromptsConfig.tsx         modal for managing slash-command prompts
  SettingsModal.tsx         modal for ~/.pi-web/config.yaml (replacements, dangerous patterns)
  PayloadsModal.tsx         modal for inspecting captured provider payloads
  PayloadChip.tsx + PayloadPopover.tsx  inline payload badges inside MessageView
  ProviderIcon.tsx          @lobehub/icons wrapper (one Mono or Color per provider, used in chat header + models modal)
  FileExplorer.tsx          file tree inside sidebar
  FileSearchBar.tsx         VS Code-style inline search bar (FileViewer)
  FileViewer.tsx            file content in a tab (text, image, audio, pdf)
  ShowFileRenderer.tsx      renders the `show_file` tool result inline in chat
  TabBar.tsx                tab bar (Chat + open file tabs + Todo)
  TodoPanel.tsx             user-side todo list panel (~/.pi-web/todos.db)
  TodoDescriptionView.tsx   sanitized read-only HTML render for a todo description
  RichTextEditor.tsx + RichTextEditorInner.tsx
                            Tiptap-based rich text editor (used in TodoPanel)
  TextColorPicker.tsx       editor-scoped Tiptap text color popover
  AgentTodoPanel.tsx        floating panel showing the agent's live task plan for the active session
  HighlightText.tsx         search-term <mark> wrapper (single + recursive)
  ToolCallStatsPanel.tsx    right-panel tab body (reads toolCallStatsStore)
  HttpPanel.tsx             right-panel tab: method/URL/headers/body editor + send
  HttpPanelCollections.tsx  collections drawer inside HttpPanel (search, grouped tree)
  HttpPanelSaveItemModal.tsx + HttpPanelEditCollectionModal.tsx
                            create/edit modals for the Collections feature
  CollectionPanel.tsx       right-panel tab wrapper for HttpPanelCollections
  JsonPanel.tsx             right-panel tab: textarea + tree view, persistent localStorage
  JsonTreeView.tsx + JsonHighlight.tsx
                            tree rendering + header-less JSON syntax highlighter
  TranslatePanel.tsx        right-panel tab: target-language picker + LLM call
  DiffPanel.tsx             right-panel tab: unified/split diff viewer (localStorage persisted)
  SchedulerModal.tsx        modal opened from the avatar menu: cron-task CRUD + run history (single-stack list/runs/form views)
  DatePicker.tsx            small calendar popover (deadlines + scheduler "next run" preview)
  CanvasPanel.tsx + CanvasPanelInner.tsx
                            Excalidraw whiteboard (dynamic import, IndexedDB-backed)
  MermaidBlock.tsx          renders ```mermaid via beautiful-mermaid (dynamic import of elkjs)
  SvgBlock.tsx              sanitized inline <svg> renderer for assistant output
  CodeBlock.tsx             shared syntax-highlighted code block (Prism, copy, line numbers)
  PermissionDialog.tsx      portal'd permission prompt (Esc/Enter/backdrop-click defaults)
  SessionSearch.tsx         in-session and cross-session keyword search UI
  AudioPlayer.tsx           audio file viewer (vinyl-disc aesthetic, 0.5x–2x speed)
  CommandPalette.tsx        ⌘K Raycast-style palette (reads commands + session results)
  CollapsiblePanel.tsx      CSS-grid-based height-animating wrapper
  ContextMenu.tsx           reusable right-click menu
  ConfirmDialog.tsx         reusable confirm dialog
  Toast.tsx                 toast notifications
  Tooltip.tsx               Radix-backed tooltip wrapper
  ImageLightbox.tsx         image preview overlay
  FileIcons.tsx             file-type icon set
  WeChatSettingsSection.tsx
                            WeChat login + send-to-workspace settings
  ReplayBar.tsx            replay controls above ChatWindow (rewind/step through earlier turns)
  FinancePanel.tsx + FinanceEntryModal.tsx + FinanceQuickEntry.tsx + FinanceStatsCards.tsx
  + FinanceTransactionList.tsx  right-panel tab for the finance ledger
  NotesPanel.tsx           right-panel tab for markdown notes + tags
  RssPanel.tsx             right-panel tab for RSS feeds / articles / read state

hooks/
  useAgentSession.ts        everything chat-window-related: load, stream, fork,
                            navigate, set model/tools/thinking, compact, steer
  useAgentTodo.ts           polls /api/agent/[id]/agent-todo every 1.5s for the active session
  useI18n.tsx               en/zh dictionary + locale toggle (t() / useI18n())
  useTheme.ts               CSS theme preset toggle
  useTodos.tsx              todos provider + hook for TodoPanel
  usePendingPermissions.tsx provider for the in-session permission queue + PermissionDialog host
  sessionUiStore.ts         module-scoped useSyncExternalStore: branch leaf + agent controls
  toolCallStatsStore.ts     module-scoped useSyncExternalStore: per-turn stats view
  httpStore.ts              module-scoped useSyncExternalStore: HTTP panel draft state
  useHttpCollections.ts     single-snapshot GET on mount + window focus (no SWR, no client cache)
  useToolCallStats.ts + ToolCallStatsContext.tsx
                            per-turn tool-call statistics reducer + provider
  useDragDrop.ts            drag-and-drop file/image upload
  useAudio.ts               tone for agent-end notifications
  useFinance.ts             single-snapshot GET finance ledger + mutate via /api/finance
  useNotes.tsx              notes provider + tag list + image upload
  useRss.ts                 RSS feeds/articles polling + mark-read actions

extensions/
  clawd-on-desk/            vendored pi extension: shouldReport() forced to () => true
                            (see `pi-web-never-binds-extension-ui` memory)

electron-shell/
  main.js                   Electron entry: window + tray + global shortcut + single-instance
  titlebar.html             macOS-style traffic-light titlebar + iframe allow="clipboard-read; clipboard-write"
  titlebar.js               IPC bridge: traffic-light buttons + F12/Ctrl+Shift+I DevTools toggle
  titlebar.css              titlebar styling
  preload.js                contextBridge preload
  pi.png                    tray + window icon
  start-pi-agent.vbs        Windows launcher helper

scripts/
  todos-restore.ts                   roll back todos.db → todos.json
  test-http-collections-store.ts     smoke test for the collections CRUD
  deploy-systemd-user.sh             deploy to ~/.local/share/pi-web-fork + install user systemd unit
  copy-excalidraw-fonts.mjs          one-time Excalidraw font copy (postinstall-ish)
  build-wenkai-fonts.ts              regenerate vendored LXGW WenKai woff2 (manual)

docs/
  agent-todo/                        design + implementation plan for the agent_todo tool
  subagent-design.md                 exploration doc for pi subagent support (not yet implemented)
  beautiful-mermaid-examples.md      diagram examples that render in beautiful-mermaid
  SKILL_find_skills.md               notes on the marketplace skill discovery flow
  openclaw-weixin-integration.md     reference for the WeChat (openclaw) integration
  wechat-integration.html             interactive docs for the WeChat flow
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)
- `customTools` registered here: `buildTodoTools(...)`, `buildShowFileTool()`, `buildAgentTodoTool()` — the trio that gives pi-web sessions their distinctive toolset

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file. Fork also copies the parent's `~/.pi-web/agent-todo/<oldSid>.jsonl` to the new session id so the agent's plan survives the branch point.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called when loading messages from session files (`session-reader.ts`) and when processing streaming events in `useAgentSession`.

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). `ToolPanel` exports only two presets — `"none"` (empty array) and `"full"` (every tool pi registers at runtime); `PRESET_NONE` is the single named export. When tools are fully disabled (`toolNames = []`), `rpc-manager.ts` clears `agent.state.systemPrompt` directly (the only way to truly blank it — `buildSystemPrompt` always emits non-empty).

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`, plus per-model `thinkingLevels` and `thinkingLevelMaps`. `useAgentSession` pre-selects `defaultModel` on mount for new sessions.

### SSE reconnect on page refresh mid-stream
On `useAgentSession` mount, `GET /api/sessions/[id]?includeState` is called. If `agentState.state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel`, `isCompacting`, and `contextUsage` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Module-scoped stores
`sessionUiStore`, `toolCallStatsStore`, and `httpStore` all follow the same pattern: one typed state object, `useSyncExternalStore` subscription, content-equality guarded patcher (`lib/shallowEqual.ts`). Callback handles are kept in refs outside the snapshot — `sessionUiStore` exposes both a state snapshot and a separate `useAgentControls()` hook, while `httpStore` uses module-level action helpers that mutate the draft directly — so identity-based re-render loops are avoided. When adding a new cross-cutting UI state, follow this pattern — it survives `ChatWindow` remounts and eliminates prop-drilling.

### HTTP proxy in-flight registry
`getInFlightRegistry()` returns a `Map<id, AbortController>` stored on `globalThis.__piHttpInFlight`. The route writes on entry and removes on completion; `POST /api/http/[id]/cancel` looks up by id and calls `controller.abort()`. Process-exit / SIGINT / SIGTERM hooks iterate the map and abort every entry so we never leak a pending upstream fetch.

### Description sanitization is centralized
`lib/description-sanitize.ts` is the single source of truth for the DOMPurify config used by every code path that touches a todo description: storage normalization, editor save/mount, read-only view render, legacy markdown migration, and zip export (which uses `allowStyle: false`). Adding a new tag/attribute to descriptions requires touching this one file. The `style` widening is gated by an idempotent `uponSanitizeAttribute` hook that rewrites every style value to only `color: #rrggbb` — opening `style` without that hook would be a CSS-injection vector.

### Permission defaults are safe
`PermissionDialog` (Esc → deny, Enter → allow once, backdrop-click → deny) deliberately biases toward deny because "allow similar for this session" is a mouse-only action — keyboard users can never accidentally over-grant.

### pi extensions never see a UI
`startRpcSession` does not call `bindExtensions`, so `ctx.hasUI` is `false` in every pi-web session. Extensions that gate on `hasUI` (e.g. `extensions/clawd-on-desk/`) need their vendored `index.ts` to override `shouldReport` to `() => true` — see the `pi-web-never-binds-extension-ui` memory for the full pattern.

### Translate panel does not touch disk
`/api/translate` builds a custom `ResourceLoader` that returns empty arrays for everything plus `SessionManager.inMemory()` + `SettingsManager.inMemory()` + `noTools: "all"`. This guarantees the request never reads `~/.pi/agent/settings.json`, never fires any extension hook, and never writes a `.jsonl` file — see the comment at the top of `app/api/translate/route.ts`.

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

## Agent Todo JSONL Format

Location: `~/.pi-web/agent-todo/<sessionId>.jsonl`

```jsonl
{"ts":<ms>,"action":"create","stateAfter":{"tasks":[...],"nextId":2}}
{"ts":<ms>,"action":"update","stateAfter":{...}}
```

Append-only snapshots — current state is the last parsed line's `stateAfter`. O(1) tail read. `agent-todo-store.ts` always `fsync`s before returning the tool result, and the frontend picks up new state via 1.5s HTTP polling on `/api/agent/[id]/agent-todo` (`useAgentTodo.ts`), not via SSE. Tombstoned tasks are kept (not deleted) so `blockedBy` references and audit history still resolve.

---

## CSS Variables (`app/globals.css`)

Theme presets (`.theme-default`, `.theme-midnight`, `.theme-synthwave`, `.theme-forest`, …) set these vars; pick from `useTheme`.

```
--bg --bg-panel --bg-hover --bg-selected --bg-subtle --border
--text --text-muted --text-dim
--accent --accent-hover --user-bg --assistant-bg --tool-bg
--font-sans --font-mono
```

The LXGW WenKai font (CJK, vendored in `lib/fonts/`) is loaded via `next/font/local` in `app/layout.tsx` and exposed as `--font-wenkai-sans`. Noto Sans Mono is loaded via `next/font/google` as `--font-noto-mono`.

---

## i18n for Frontend Text

**All user-visible strings in new components must go through i18n — never hardcode display text.**

When adding or modifying frontend components:
- Extract every user-facing string (labels, placeholders, tooltips, aria-labels, status messages, error text) into the i18n dictionary at `hooks/useI18n.tsx`.
- Use the project's existing i18n mechanism (`t('key')` from `useI18n()`) — don't invent a new pattern.
- Keys are the English source string itself; add the Chinese translation in the `ZH_TRANSLATIONS` map. Look at nearby keys before creating new ones.

---

## Toast Notifications for New Frontend Interactions

**Any new user-initiated frontend action that can fail or completes silently needs a toast — see `components/Toast.tsx` for the global system.**

When adding or modifying frontend interactions, decide whether a toast is needed:

- **Add a toast** for: server-bound actions (save, delete, rename, fork, send, copy, fetch, OAuth login, install, export, scheduler run, HTTP send/cancel) and for successes of operations that otherwise complete silently.
- **Skip a toast** for: actions whose feedback is purely local UI state (toggles, expand/collapse, theme switch, sound on/off) and for forms where the error must stay inline next to the field (rename conflicts, validation messages, modal-internal footer text).

Conventions:
- Call `useToast()` from `./Toast` (or `@/components/Toast`) and invoke `toast.show({ kind, message })` — don't invent a parallel notification mechanism.
- Prefer the server-provided error string and fall back to a generic i18n key: `e instanceof Error && e.message ? e.message : t("Network error")`.
- Past-tense keys cover most successes (`t("Saved")`, `t("Renamed")`, `t("Copied")`, `t("Deleted")`); add new keys to `hooks/useI18n.tsx` only when none fits. The "Common-operation toasts" comment in `useI18n.tsx` is the canonical place to add them.
- Modal-internal feedback (the "Saved" button label, red footer text) should stay in addition to the toast — the toast is the cross-area confirmation that survives outside the modal.
- The 1-second dedupe in `Toast.tsx` handles repeated onerror events; don't add your own.
- `useConfirm()` from `./ConfirmDialog` is the matching modal for destructive confirms ("Delete this collection?", "Cancel this HTTP request?") — pair with a toast on success.

---

## Clipboard in the Electron Shell

When Pi Work is loaded inside the `electron-shell` `<iframe>`, every
`navigator.clipboard.writeText()` call requires the iframe to declare
`allow="clipboard-read; clipboard-write"` (set in `electron-shell/titlebar.html`).
Without it, Chromium's Permissions-Policy silently blocks the call. The web
app has a `document.execCommand("copy")` fallback in `components/CodeBlock.tsx`'s
`copyText()` helper (also reached by `HttpPanel`'s copy button via that import,
plus `MermaidBlock.tsx`, `SvgBlock.tsx`, `FileExplorer.tsx`) — but the iframe
attribute is the canonical fix and the fallback should not be relied on.

---

# Interaction

- Interact with users in Chinese.
- Interact with users in Chinese.
- Interact with users in Chinese.
