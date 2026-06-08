import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface Todo {
  id: string;
  title: string;
  description?: string;
  done: boolean;
  createdAt: number;
  completedAt?: number;
}

function isTodo(v: unknown): v is Todo {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.title === "string" &&
    typeof o.done === "boolean" &&
    typeof o.createdAt === "number" &&
    (o.description === undefined || typeof o.description === "string") &&
    (o.completedAt === undefined || typeof o.completedAt === "number")
  );
}

export function readTodos(filePath: string): Todo[] {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter(isTodo);
  } catch {
    return [];
  }
}

export function writeTodos(filePath: string, todos: Todo[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(todos, null, 2), "utf-8");
}

export function generateTodoId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
