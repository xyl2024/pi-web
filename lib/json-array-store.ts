import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export function readStringArray(filePath: string): string[] {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (Array.isArray(data) && data.every((v) => typeof v === "string")) {
      return data as string[];
    }
    return [];
  } catch {
    return [];
  }
}

export function writeStringArray(filePath: string, values: string[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(values, null, 2), "utf-8");
}
