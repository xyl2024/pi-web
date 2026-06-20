import type { DangerousPatternsConfig } from "./config";
import { readConfig } from "./config";
import { createLogger } from "./logger";

const log = createLogger("dangerous-patterns");

interface CompiledRule {
  name: string;
  regex: RegExp;
}

let compiledCache: CompiledRule[] | null = null;
let compiledFromConfig: DangerousPatternsConfig | null = null;

function compileRules(cfg: DangerousPatternsConfig): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const rule of cfg.rules) {
    try {
      out.push({ name: rule.name, regex: new RegExp(rule.pattern) });
    } catch (err) {
      log.warn("invalid dangerous pattern, skipping", { name: rule.name, error: String(err) });
    }
  }
  return out;
}

function getCompiled(): { cfg: DangerousPatternsConfig; compiled: CompiledRule[] } {
  const cfg = readConfig().dangerous_patterns;
  if (compiledCache && compiledFromConfig === cfg) {
    return { cfg, compiled: compiledCache };
  }
  const compiled = compileRules(cfg);
  compiledCache = compiled;
  compiledFromConfig = cfg;
  return { cfg, compiled };
}

/**
 * Load dangerous-pattern config and match a bash command against it.
 * Returns the rule name of the first match, or null if no rule matched.
 * When no rules are configured this returns null and the caller should pass.
 */
export function matchDangerousPattern(command: string): { ruleName: string } | null {
  const { compiled } = getCompiled();
  if (compiled.length === 0) return null;
  for (const c of compiled) {
    if (c.regex.test(command)) return { ruleName: c.name };
  }
  return null;
}

/**
 * Get the configured timeout (ms) for permission requests.
 */
export function getDangerousPatternTimeoutMs(): number {
  const { cfg } = getCompiled();
  return cfg.timeout_ms;
}

// Exposed for tests / debugging
export function _resetDangerousPatternsCache(): void {
  compiledCache = null;
  compiledFromConfig = null;
}