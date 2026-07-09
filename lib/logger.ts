import { appendFileSync, mkdirSync } from "fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "path";
import { homedir } from "os";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_LEVEL: LogLevel = process.env.NODE_ENV === "production" ? "warn" : "debug";
let fileLogPathBase: string | null | undefined;
let fileLoggingFailed = false;

function getConfiguredLevel(): LogLevel {
  const value = process.env.PI_WEB_LOG_LEVEL?.toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return DEFAULT_LEVEL;
}

function serializeFields(fields?: Record<string, unknown>): string {
  if (!fields) return "";

  try {
    return " " + JSON.stringify(fields, (_key, value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
      return value;
    });
  } catch {
    return " " + JSON.stringify({ fields: "[unserializable]" });
  }
}

function resolveConfiguredPath(value: string): string {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function getDefaultLogDir(): string {
  const configuredDir = process.env.PI_WEB_LOG_DIR?.trim();
  if (configuredDir) return resolveConfiguredPath(configuredDir);

  return join(homedir(), ".pi-web", "logs");
}

function getDateStamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDateToFileName(filePath: string, dateStamp: string): string {
  const dir = dirname(filePath);
  const ext = extname(filePath);
  const name = basename(filePath, ext);
  return join(dir, `${name}-${dateStamp}${ext || ".log"}`);
}

function getFileLogPathBase(): string | null {
  if (fileLogPathBase !== undefined) return fileLogPathBase;

  const configuredFile = process.env.PI_WEB_LOG_FILE?.trim();
  if (configuredFile?.toLowerCase() === "off" || configuredFile?.toLowerCase() === "false") {
    fileLogPathBase = null;
    return fileLogPathBase;
  }

  fileLogPathBase = configuredFile
    ? resolveConfiguredPath(configuredFile)
    : join(getDefaultLogDir(), "pi-web.log");
  return fileLogPathBase;
}

function getFileLogPath(): string | null {
  const basePath = getFileLogPathBase();
  if (!basePath) return null;
  return addDateToFileName(basePath, getDateStamp());
}

function writeFileLog(line: string): void {
  if (fileLoggingFailed) return;

  const path = getFileLogPath();
  if (!path) return;

  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line + "\n", "utf8");
  } catch (error) {
    fileLoggingFailed = true;
    console.error(`[${new Date().toISOString()}] [ERROR] [logger] failed to write log file ${path}: ${String(error)}`);
  }
}

function writeLog(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[getConfiguredLevel()]) return;

  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${message}${serializeFields(fields)}`;
  switch (level) {
    case "debug":
      console.debug(line);
      break;
    case "info":
      console.info(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
  }
  writeFileLog(line);
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, fields?: Record<string, unknown>) => writeLog("debug", scope, message, fields),
    info: (message: string, fields?: Record<string, unknown>) => writeLog("info", scope, message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => writeLog("warn", scope, message, fields),
    error: (message: string, fields?: Record<string, unknown>) => writeLog("error", scope, message, fields),
  };
}

export function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}
