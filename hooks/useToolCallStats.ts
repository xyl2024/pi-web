"use client";

import { useState, useCallback, useReducer, useEffect, useRef } from "react";
import type { AgentMessage, ToolCallContent, ToolResultMessage, AssistantMessage } from "@/lib/types";
import { useToolCallStatsRegister } from "./ToolCallStatsContext";
import type { ToolCallStatsEvent } from "./ToolCallStatsContext";

// ── Data types ──

export interface PerToolStat {
  count: number;
  successCount: number;
  errorCount: number;
}

export type BashExitStatus =
  | { kind: "ok"; code: number }
  | { kind: "nonzero"; code: number }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "unknown" };

export interface BashRecord {
  toolCallId: string;
  command: string;
  isError: boolean;
  exit: BashExitStatus;
  /** First text block of the result, truncated to ~1KB. Empty string when not yet ended. */
  resultText: string;
  /** toolName is always "bash"; kept for symmetry / future-proofing. */
  toolName: string;
  timestamp: number;
}

export interface ToolCallStatsSnapshot {
  toolStats: Map<string, PerToolStat>;
  bashRecords: BashRecord[];
  totalCount: number;
  runningCount: number;
}

// ── Bash helpers ──

const EXIT_CODE_RE = /Command exited with code (-?\d+)/;
const TIMEOUT_RE = /Command timed out after (\d+) seconds/;
const ABORTED_RE = /Command aborted\b/;

/** Parse a `BashExitStatus` from the first text block of a bash tool result.
 *  pi's bash tool throws an Error whose message contains the exit code on
 *  non-zero exit, the timeout on timeout, or "aborted" on signal. */
function parseBashExit(resultText: string | undefined, isError: boolean): BashExitStatus {
  if (!isError) return { kind: "ok", code: 0 };
  if (!resultText) return { kind: "unknown" };
  const m = resultText.match(EXIT_CODE_RE);
  if (m && m[1] !== undefined) {
    const n = Number.parseInt(m[1], 10);
    return { kind: "nonzero", code: Number.isFinite(n) ? n : 0 };
  }
  if (TIMEOUT_RE.test(resultText)) return { kind: "timeout" };
  if (ABORTED_RE.test(resultText)) return { kind: "aborted" };
  return { kind: "unknown" };
}

function extractBashCommand(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const cmd = args["command"];
  return typeof cmd === "string" ? cmd : "";
}

// ── Reducer ──

interface StatsState {
  toolStats: Map<string, PerToolStat>;
  bashRecords: BashRecord[];
  running: Map<string, { toolName: string; args?: Record<string, unknown> }>;
}

type StatsAction =
  | {
      type: "tool_start";
      toolCallId: string;
      toolName: string;
      timestamp: number;
      args?: Record<string, unknown>;
    }
  | {
      type: "tool_end";
      toolCallId: string;
      isError: boolean;
      timestamp: number;
      resultText?: string;
    }
  | { type: "reset"; toolStats: Map<string, PerToolStat>; bashRecords: BashRecord[] };

function statsReducer(state: StatsState, action: StatsAction): StatsState {
  switch (action.type) {
    case "tool_start": {
      const nextStats = new Map(state.toolStats);
      const prev = nextStats.get(action.toolName);
      nextStats.set(action.toolName, {
        count: (prev?.count ?? 0) + 1,
        successCount: prev?.successCount ?? 0,
        errorCount: prev?.errorCount ?? 0,
      });
      const nextRunning = new Map(state.running);
      nextRunning.set(action.toolCallId, { toolName: action.toolName, args: action.args });

      let nextBash = state.bashRecords;
      if (action.toolName === "bash") {
        const command = extractBashCommand(action.args);
        const record: BashRecord = {
          toolCallId: action.toolCallId,
          command,
          isError: false,
          exit: { kind: "unknown" },
          resultText: "",
          toolName: "bash",
          timestamp: action.timestamp,
        };
        nextBash = [...state.bashRecords, record];
      }
      return { toolStats: nextStats, bashRecords: nextBash, running: nextRunning };
    }
    case "tool_end": {
      const runningEntry = state.running.get(action.toolCallId);
      if (!runningEntry) return state;
      const isError = action.isError;
      const nextStats = new Map(state.toolStats);
      const prev = nextStats.get(runningEntry.toolName);
      if (prev) {
        nextStats.set(runningEntry.toolName, {
          ...prev,
          successCount: prev.successCount + (isError ? 0 : 1),
          errorCount: prev.errorCount + (isError ? 1 : 0),
        });
      }
      const nextRunning = new Map(state.running);
      nextRunning.delete(action.toolCallId);

      let nextBash = state.bashRecords;
      if (runningEntry.toolName === "bash") {
        const resultText = action.resultText ?? "";
        const exit = parseBashExit(resultText, isError);
        nextBash = state.bashRecords.map((r) =>
          r.toolCallId === action.toolCallId
            ? { ...r, isError, exit, resultText }
            : r,
        );
      }
      return { toolStats: nextStats, bashRecords: nextBash, running: nextRunning };
    }
    case "reset":
      return { toolStats: action.toolStats, bashRecords: action.bashRecords, running: new Map() };
    default:
      return state;
  }
}

// ── Build initial stats from messages ──

interface BuiltStats {
  toolStats: Map<string, PerToolStat>;
  bashRecords: BashRecord[];
}

function buildStatsFromMessages(messages: AgentMessage[]): BuiltStats {
  const toolStats = new Map<string, PerToolStat>();
  const bashRecords: BashRecord[] = [];
  const resultsById = new Map<string, ToolResultMessage>();
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      resultsById.set(msg.toolCallId, msg);
    }
  }

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const assistantMsg = msg as AssistantMessage;
    const assistantTs = assistantMsg.timestamp ?? 0;

    for (const block of assistantMsg.content) {
      if (block.type !== "toolCall") continue;
      const tc = block as ToolCallContent;
      const toolName = tc.toolName;
      const result = resultsById.get(tc.toolCallId);
      const hasResult = !!result;
      const isError = result?.isError ?? false;

      const prev = toolStats.get(toolName);
      toolStats.set(toolName, {
        count: (prev?.count ?? 0) + 1,
        successCount: (prev?.successCount ?? 0) + (hasResult ? (isError ? 0 : 1) : 0),
        errorCount: (prev?.errorCount ?? 0) + (hasResult ? (isError ? 1 : 0) : 0),
      });

      if (toolName === "bash") {
        const command = extractBashCommand(tc.input);
        let resultText = "";
        let exit: BashExitStatus = { kind: "unknown" };
        if (result) {
          const firstText = result.content.find((c) => c.type === "text");
          if (firstText && firstText.type === "text") {
            resultText = firstText.text.length > 1024
              ? firstText.text.slice(0, 1024) + "…"
              : firstText.text;
          }
          exit = parseBashExit(resultText, isError);
        }
        bashRecords.push({
          toolCallId: tc.toolCallId,
          command,
          isError,
          exit,
          resultText,
          toolName: "bash",
          timestamp: assistantTs,
        });
      }
    }
  }

  return { toolStats, bashRecords };
}

// ── Hook ──

export interface UseToolCallStatsReturn {
  snapshot: ToolCallStatsSnapshot;
  isDrawerOpen: boolean;
  toggleDrawer: () => void;
}

export function useToolCallStats(messages: AgentMessage[]): UseToolCallStatsReturn {
  const [state, dispatch] = useReducer(statsReducer, null, () => {
    const init = buildStatsFromMessages(messages);
    return { toolStats: init.toolStats, bashRecords: init.bashRecords, running: new Map() };
  });

  const [isDrawerOpen, setDrawerOpen] = useState(false);
  const toggleDrawer = useCallback(() => setDrawerOpen((v) => !v), []);

  // Register with the context so useAgentSession can push events here
  const stableDispatch = useCallback((event: ToolCallStatsEvent) => {
    switch (event.type) {
      case "tool_start":
        dispatch({
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          timestamp: event.timestamp,
          args: event.args,
        });
        break;
      case "tool_end":
        dispatch({
          type: "tool_end",
          toolCallId: event.toolCallId,
          isError: event.isError,
          timestamp: event.timestamp,
          resultText: event.resultText,
        });
        break;
      case "reset":
        dispatch({ type: "reset", toolStats: new Map(), bashRecords: [] });
        break;
    }
  }, []);

  useToolCallStatsRegister(stableDispatch);

  // Recompute when messages change (session switch)
  const prevMessagesLenRef = useRef(messages.length);
  useEffect(() => {
    // Only recompute if the messages array changed identity AND length differs
    // (avoid recomputing on every render from streaming updates)
    if (messages.length !== prevMessagesLenRef.current) {
      prevMessagesLenRef.current = messages.length;
      const init = buildStatsFromMessages(messages);
      dispatch({ type: "reset", toolStats: init.toolStats, bashRecords: init.bashRecords });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  // Derive snapshot
  const snapshot: ToolCallStatsSnapshot = {
    toolStats: state.toolStats,
    bashRecords: state.bashRecords,
    totalCount: state.toolStats.size > 0
      ? Array.from(state.toolStats.values()).reduce((s, v) => s + v.count, 0)
      : state.bashRecords.length,
    runningCount: state.running.size,
  };

  return { snapshot, isDrawerOpen, toggleDrawer };
}
