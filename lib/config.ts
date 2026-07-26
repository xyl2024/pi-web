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

export interface PiWebConfig {
  dangerous_patterns: DangerousPatternsConfig;
  extensions: ExtensionsConfig;
}

const DEFAULT_DANGEROUS_PATTERNS: DangerousPatternsConfig = {
  rules: [],
  timeout_ms: 300_000,
};

const DEFAULT_CONFIG: PiWebConfig = {
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
