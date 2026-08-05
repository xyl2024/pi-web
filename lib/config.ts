import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { load, dump } from "js-yaml";
import { createLogger } from "./logger";

const log = createLogger("config");

export interface DangerousPatternRule {
  name: string;
  pattern: string;
}

export interface DangerousPatternsConfig {
  rules: DangerousPatternRule[];
  timeout_ms: number;
}

export interface BuiltinExtensionConfig {
  enabled: boolean;
}

export interface ExtensionsConfig {
  clawd_on_desk: BuiltinExtensionConfig;
}

// ── Right-side button bar visibility ──────────────────────────────────────
// Each key is the user-facing id of a configurable right-bar tab button.
// Missing keys default to true (visible) — both in defaults and in the parser.

export type RightBarButtonId =
  | "todos"
  | "canvas"
  | "translate"
  | "json"
  | "diff"
  | "rss"
  | "favorites"
  | "tokens"
  | "toolCalls";

export const RIGHT_BAR_BUTTON_IDS: readonly RightBarButtonId[] = [
  "todos",
  "canvas",
  "translate",
  "json",
  "diff",
  "rss",
  "favorites",
  "tokens",
  "toolCalls",
] as const;

export type RightSideBarConfig = Record<RightBarButtonId, boolean>;

// ── Custom tools enabled by `customTools` on createAgentSession ───────────
// Names match the tool names registered in lib/rpc-manager.ts. The two
// built-in user-side todo tools (`user_todos_list`, `user_todo_description`)
// live in lib/todo-tools-config.ts and are NOT listed here — they are gated
// by ~/.pi-web/todo-tools.json for historical reasons. Adding a new tool
// to `customTools` in rpc-manager.ts requires adding it here too, or the
// validator will silently drop it (fail-open default still applies, but
// the user setting is lost).

export type AgentCustomToolName = "agent_todo" | "show_file";

export const AGENT_CUSTOM_TOOL_NAMES: readonly AgentCustomToolName[] = [
  "agent_todo",
  "show_file",
] as const;

export interface CustomToolsConfig {
  enabled: AgentCustomToolName[];
}

// ── APPEND_SYSTEM.md loader toggle ───────────────────────────────────────
// pi's DefaultResourceLoader auto-loads ~/.pi/agent/APPEND_SYSTEM.md on
// every session. Disabling here passes `appendSystemPrompt: []` to the
// loader, which short-circuits `discoverAppendSystemPromptFile()` — the
// file is left untouched on disk so re-enabling just flips the flag.
export interface AppendSystemConfig {
  enabled: boolean;
}

export interface PiWebConfig {
  dangerous_patterns: DangerousPatternsConfig;
  extensions: ExtensionsConfig;
  right_side_bar: RightSideBarConfig;
  custom_tools: CustomToolsConfig;
  append_system: AppendSystemConfig;
}

const DEFAULT_DANGEROUS_PATTERNS: DangerousPatternsConfig = {
  rules: [],
  timeout_ms: 300_000,
};

const DEFAULT_RIGHT_SIDE_BAR: RightSideBarConfig = {
  todos: true,
  canvas: true,
  translate: true,
  json: true,
  diff: true,
  rss: true,
  favorites: true,
  tokens: true,
  toolCalls: true,
};

const DEFAULT_CONFIG: PiWebConfig = {
  dangerous_patterns: DEFAULT_DANGEROUS_PATTERNS,
  extensions: {
    clawd_on_desk: { enabled: false },
  },
  right_side_bar: { ...DEFAULT_RIGHT_SIDE_BAR },
  custom_tools: {
    enabled: [...AGENT_CUSTOM_TOOL_NAMES],
  },
  // Preserve pre-existing behavior: append file loads by default.
  append_system: { enabled: true },
};

function parseDangerousPatterns(raw: unknown): DangerousPatternsConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DANGEROUS_PATTERNS };
  const obj = raw as Record<string, unknown>;
  const rulesRaw = Array.isArray(obj.rules) ? obj.rules : [];
  const rules: DangerousPatternRule[] = [];
  for (const r of rulesRaw) {
    if (!r || typeof r !== "object") continue;
    const rule = r as Record<string, unknown>;
    if (typeof rule.name === "string" && typeof rule.pattern === "string") {
      rules.push({ name: rule.name, pattern: rule.pattern });
    }
  }
  const timeoutRaw = obj.timeout_ms;
  const timeout_ms = typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? timeoutRaw
    : DEFAULT_DANGEROUS_PATTERNS.timeout_ms;
  return { rules, timeout_ms };
}

function parseRightSideBar(raw: unknown): RightSideBarConfig {
  const out: RightSideBarConfig = { ...DEFAULT_RIGHT_SIDE_BAR };
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const key of RIGHT_BAR_BUTTON_IDS) {
    if (typeof obj[key] === "boolean") out[key] = obj[key] as boolean;
    // missing or non-boolean → keep default (true)
  }
  return out;
}

// Fail-open only when the field is genuinely missing / unreadable —
// an explicit `enabled: []` MUST be honored as "disable everything"
// (the user pushed the button, we trust them). When the array is
// non-empty but every entry is unknown, fall back to defaults: that's
// almost certainly a typo / schema mismatch and silently disabling
// every tool would be a worse surprise than the typo itself.
function parseCustomTools(raw: unknown): CustomToolsConfig {
  if (!raw || typeof raw !== "object") return { enabled: [...AGENT_CUSTOM_TOOL_NAMES] };
  const obj = raw as Record<string, unknown>;
  const enabledRaw = obj.enabled;
  if (!Array.isArray(enabledRaw)) return { enabled: [...AGENT_CUSTOM_TOOL_NAMES] };
  if (enabledRaw.length === 0) return { enabled: [] };
  const seen = new Set<AgentCustomToolName>();
  for (const item of enabledRaw) {
    if (typeof item === "string" && (AGENT_CUSTOM_TOOL_NAMES as readonly string[]).includes(item)) {
      seen.add(item as AgentCustomToolName);
    }
  }
  if (seen.size === 0) return { enabled: [...AGENT_CUSTOM_TOOL_NAMES] };
  return { enabled: [...seen] };
}

// Fail-open for the missing/garbled case (keep the on-by-default behavior
// so an old config.yaml doesn't silently turn the append off). An explicit
// `enabled: false` is honored — the user pushed the button, we trust them.
function parseAppendSystem(raw: unknown): AppendSystemConfig {
  if (!raw || typeof raw !== "object") return { enabled: true };
  const obj = raw as Record<string, unknown>;
  return { enabled: obj.enabled !== false };
}

const CONFIG_DIR = join(homedir(), ".pi-web");
const CONFIG_PATH = join(CONFIG_DIR, "config.yaml");

function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

function writeDefaultConfig(): PiWebConfig {
  try {
    ensureConfigDir();
    writeFileSync(CONFIG_PATH, dump(DEFAULT_CONFIG), "utf8");
    log.info("created default config", { path: CONFIG_PATH });
  } catch (err) {
    log.error("failed to write default config", { error: String(err) });
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Read config from ~/.pi-web/config.yaml.
 * On any error (file missing, corrupt yaml, wrong shape),
 * overwrites with defaults and returns them.
 */
export function readConfig(): PiWebConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = load(raw);

    if (!parsed || typeof parsed !== "object") {
      log.warn("config yaml parsed to non-object, resetting to defaults");
      return writeDefaultConfig();
    }

    const cfg = parsed as Record<string, unknown>;

    const extObj = (cfg.extensions && typeof cfg.extensions === "object")
      ? cfg.extensions as Record<string, unknown>
      : {};
    const codObj = (extObj.clawd_on_desk && typeof extObj.clawd_on_desk === "object")
      ? extObj.clawd_on_desk as Record<string, unknown>
      : {};
    const clawdOnDeskEnabled = typeof codObj.enabled === "boolean" ? codObj.enabled : false;

    return {
      dangerous_patterns: parseDangerousPatterns(cfg.dangerous_patterns),
      extensions: {
        clawd_on_desk: { enabled: clawdOnDeskEnabled },
      },
      right_side_bar: parseRightSideBar(cfg.right_side_bar),
      custom_tools: parseCustomTools(cfg.custom_tools),
      append_system: parseAppendSystem(cfg.append_system),
    };
  } catch (err) {
    log.warn("failed to read config, resetting to defaults", { error: String(err) });
    return writeDefaultConfig();
  }
}

/**
 * Write config to ~/.pi-web/config.yaml.
 * Returns the written config on success, throws on failure.
 */
export function writeConfig(config: PiWebConfig): PiWebConfig {
  ensureConfigDir();
  writeFileSync(CONFIG_PATH, dump(config), "utf8");
  log.info("config written", { path: CONFIG_PATH });
  return config;
}
