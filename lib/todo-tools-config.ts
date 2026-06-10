import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { TODO_TOOL_NAMES, type TodoToolName } from "./todo-tools";

const CONFIG_DIR = join(homedir(), ".pi-web");
const CONFIG_PATH = join(CONFIG_DIR, "todo-tools.json");

function isTodoToolName(value: unknown): value is TodoToolName {
  return typeof value === "string" && (TODO_TOOL_NAMES as readonly string[]).includes(value);
}

function validate(value: unknown): TodoToolName[] {
  if (!Array.isArray(value)) return [...TODO_TOOL_NAMES];
  const seen = new Set<TodoToolName>();
  for (const item of value) {
    if (isTodoToolName(item) && !seen.has(item)) {
      seen.add(item);
    }
  }
  return [...seen];
}

/**
 * Read the enabled todo tool names from ~/.pi-web/todo-tools.json.
 * On missing / corrupt / unknown file, returns the default (all 4 enabled).
 */
export function readEnabledTodoTools(): TodoToolName[] {
  if (!existsSync(CONFIG_PATH)) return [...TODO_TOOL_NAMES];
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return validate(parsed);
  } catch {
    return [...TODO_TOOL_NAMES];
  }
}

export function writeEnabledTodoTools(names: TodoToolName[]): TodoToolName[] {
  const validated = validate(names);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(validated, null, 2), "utf-8");
  return validated;
}
