import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
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

export interface PiWebConfig {
  system_prompt_replacements: SystemPromptReplacements;
}

const DEFAULT_CONFIG: PiWebConfig = {
  system_prompt_replacements: {
    enabled: false,
    rules: [],
  },
};

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

    return {
      system_prompt_replacements: {
        enabled: sprObj.enabled as boolean,
        rules,
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
