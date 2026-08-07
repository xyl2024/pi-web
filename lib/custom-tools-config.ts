/**
 * Read which agent-side custom tools are enabled for `createAgentSession`.
 *
 * Backed by `~/.pi-work/config.yaml` → `custom_tools.enabled` (array of
 * tool names). Parsing + fail-open defaults live in `lib/config.ts`
 * (`parseCustomTools`); this file is just the typed accessor used by
 * `lib/rpc-manager.ts`.
 *
 * Returns a Set for O(1) membership checks at session start. An empty
 * Set is a valid result — it means the user explicitly disabled every
 * custom tool via the Settings UI, and `createAgentSession` will
 * receive an empty `customTools` array for this category.
 *
 * Distinct from `lib/todo-tools-config.ts`: that file owns the two
 * user-side todo tools (`user_todos_list`, `user_todo_description`) and
 * lives in its own JSON file for historical reasons.
 */

import { readConfig, type AgentCustomToolName } from "./config";

export function readEnabledCustomTools(): Set<AgentCustomToolName> {
  return new Set<AgentCustomToolName>(readConfig().custom_tools.enabled);
}