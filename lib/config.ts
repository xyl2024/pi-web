import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { load, dump } from "js-yaml";
import { createLogger } from "./logger";

const log = createLogger("config");

export interface ReplacementRule {
  search: string;
  replace: string;
}

export interface SystemPromptReplacements {
  enabled: boolean;
  rules: ReplacementRule[];
}

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

export interface PiWebConfig {
  system_prompt_replacements: SystemPromptReplacements;
  dangerous_patterns: DangerousPatternsConfig;
  extensions: ExtensionsConfig;
}

const DEFAULT_DANGEROUS_PATTERNS: DangerousPatternsConfig = {
  rules: [],
  timeout_ms: 300_000,
};

const DEFAULT_CONFIG: PiWebConfig = {
  system_prompt_replacements: {
    enabled: false,
    rules: [],
  },
  dangerous_patterns: DEFAULT_DANGEROUS_PATTERNS,
  extensions: {
    clawd_on_desk: { enabled: false },
  },
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

    // Validate system_prompt_replacements
    const spr = cfg.system_prompt_replacements;
    if (!spr || typeof spr !== "object") {
      log.warn("config missing system_prompt_replacements, resetting to defaults");
      return writeDefaultConfig();
    }

    const sprObj = spr as Record<string, unknown>;

    if (typeof sprObj.enabled !== "boolean") {
      log.warn("config system_prompt_replacements.enabled invalid, resetting to defaults");
      return writeDefaultConfig();
    }

    if (!Array.isArray(sprObj.rules)) {
      log.warn("config system_prompt_replacements.rules not an array, resetting to defaults");
      return writeDefaultConfig();
    }

    const rules: ReplacementRule[] = [];
    for (const r of sprObj.rules) {
      if (!r || typeof r !== "object") continue;
      const rule = r as Record<string, unknown>;
      if (typeof rule.search === "string" && typeof rule.replace === "string") {
        rules.push({ search: rule.search, replace: rule.replace });
      }
    }

    const extObj = (cfg.extensions && typeof cfg.extensions === "object")
      ? cfg.extensions as Record<string, unknown>
      : {};
    const codObj = (extObj.clawd_on_desk && typeof extObj.clawd_on_desk === "object")
      ? extObj.clawd_on_desk as Record<string, unknown>
      : {};
    const clawdOnDeskEnabled = typeof codObj.enabled === "boolean" ? codObj.enabled : false;

    return {
      system_prompt_replacements: {
        enabled: sprObj.enabled as boolean,
        rules,
      },
      dangerous_patterns: parseDangerousPatterns(cfg.dangerous_patterns),
      extensions: {
        clawd_on_desk: { enabled: clawdOnDeskEnabled },
      },
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

/**
 * Apply replacement rules to a string.
 * Returns the transformed string.
 */
export function applyReplacements(text: string, rules: ReplacementRule[]): string {
  let result = text;
  for (const rule of rules) {
    if (rule.search.length === 0) continue;
    if (result.includes(rule.search)) {
      result = result.split(rule.search).join(rule.replace);
      log.info("applied replacement rule", { search: rule.search, replace: rule.replace });
    } else {
      log.info("replacement rule not matched", { search: rule.search });
    }
  }
  return result;
}
