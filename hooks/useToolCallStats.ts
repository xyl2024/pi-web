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
  totalDurationMs: number;
}

export interface WaterfallEntry {
  toolCallId: string;
  toolName: string;
  startTime: number;    // Date.now() when start event received
  endTime?: number;     // Date.now() when end event received
  isError?: boolean;
}

export interface ToolCallStatsSnapshot {
  toolStats: Map<string, PerToolStat>;
  waterfall: WaterfallEntry[];
  totalCount: number;
  runningCount: number;
}

// ── Reducer ──

interface StatsState {
  toolStats: Map<string, PerToolStat>;
  waterfall: WaterfallEntry[];
  running: Map<string, WaterfallEntry>; // toolCallId -> in-flight entry
}

type StatsAction =
  | { type: "tool_start"; toolCallId: string; toolName: string; timestamp: number }
  | { type: "tool_end"; toolCallId: string; isError: boolean; timestamp: number }
  | { type: "reset"; toolStats: Map<string, PerToolStat>; waterfall: WaterfallEntry[] };

function statsReducer(state: StatsState, action: StatsAction): StatsState {
  switch (action.type) {
    case "tool_start": {
      const entry: WaterfallEntry = {
        toolCallId: action.toolCallId,
        toolName: action.toolName,
        startTime: action.timestamp,
      };
      const nextWaterfall = [...state.waterfall, entry];
      const nextRunning = new Map(state.running);
      nextRunning.set(action.toolCallId, entry);
      const nextStats = new Map(state.toolStats);
      const prev = nextStats.get(action.toolName);
      nextStats.set(action.toolName, {
        count: (prev?.count ?? 0) + 1,
        successCount: prev?.successCount ?? 0,
        errorCount: prev?.errorCount ?? 0,
        totalDurationMs: prev?.totalDurationMs ?? 0,
      });
      return { toolStats: nextStats, waterfall: nextWaterfall, running: nextRunning };
    }
    case "tool_end": {
      const runningEntry = state.running.get(action.toolCallId);
      if (!runningEntry) return state;
      const durationMs = action.timestamp - runningEntry.startTime;
      // Update waterfall entry
      const nextWaterfall = state.waterfall.map((e) =>
        e.toolCallId === action.toolCallId
          ? { ...e, endTime: action.timestamp, isError: action.isError }
          : e
      );
      // Update tool stats
      const nextStats = new Map(state.toolStats);
      const toolName = runningEntry.toolName;
      const prev = nextStats.get(toolName);
      if (prev) {
        nextStats.set(toolName, {
          ...prev,
          successCount: prev.successCount + (action.isError ? 0 : 1),
          errorCount: prev.errorCount + (action.isError ? 1 : 0),
          totalDurationMs: prev.totalDurationMs + durationMs,
        });
      }
      const nextRunning = new Map(state.running);
      nextRunning.delete(action.toolCallId);
      return { toolStats: nextStats, waterfall: nextWaterfall, running: nextRunning };
    }
    case "reset":
      return { toolStats: action.toolStats, waterfall: action.waterfall, running: new Map() };
    default:
      return state;
  }
}

// ── Build initial stats from messages ──

function buildStatsFromMessages(messages: AgentMessage[]): { toolStats: Map<string, PerToolStat>; waterfall: WaterfallEntry[] } {
  const toolStats = new Map<string, PerToolStat>();
  const waterfall: WaterfallEntry[] = [];
  // Index tool results by toolCallId
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
      const result = resultsById.get(tc.toolCallId);
      const endTs = result?.timestamp;
      const durationMs = (endTs && assistantTs) ? endTs - assistantTs : 0;
      const isError = result?.isError ?? false;

      waterfall.push({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        startTime: assistantTs,
        endTime: endTs,
        isError: endTs ? isError : undefined,
      });

      const prev = toolStats.get(tc.toolName);
      toolStats.set(tc.toolName, {
        count: (prev?.count ?? 0) + 1,
        successCount: (prev?.successCount ?? 0) + (endTs ? (isError ? 0 : 1) : 0),
        errorCount: (prev?.errorCount ?? 0) + (endTs ? (isError ? 1 : 0) : 0),
        totalDurationMs: (prev?.totalDurationMs ?? 0) + durationMs,
      });
    }
  }

  return { toolStats, waterfall };
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
    return { toolStats: init.toolStats, waterfall: init.waterfall, running: new Map() };
  });

  const [isDrawerOpen, setDrawerOpen] = useState(false);
  const toggleDrawer = useCallback(() => setDrawerOpen((v) => !v), []);

  // Register with the context so useAgentSession can push events here
  const stableDispatch = useCallback((event: ToolCallStatsEvent) => {
    switch (event.type) {
      case "tool_start":
        dispatch({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, timestamp: event.timestamp });
        break;
      case "tool_end":
        dispatch({ type: "tool_end", toolCallId: event.toolCallId, isError: event.isError, timestamp: event.timestamp });
        break;
      case "reset":
        dispatch({ type: "reset", toolStats: new Map(), waterfall: [] });
        break;
    }
  }, []);

  useToolCallStatsRegister(stableDispatch);

  // Recompute when messages change (session switch / fork)
  const prevMessagesLenRef = useRef(messages.length);
  useEffect(() => {
    // Only recompute if the messages array changed identity AND length differs
    // (avoid recomputing on every render from streaming updates)
    if (messages.length !== prevMessagesLenRef.current) {
      prevMessagesLenRef.current = messages.length;
      const init = buildStatsFromMessages(messages);
      const kept = new Map<string, WaterfallEntry>();
      // Preserve any running entries that haven't finished yet
      state.running.forEach((entry) => kept.set(entry.toolCallId, entry));
      dispatch({ type: "reset", toolStats: init.toolStats, waterfall: init.waterfall });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  // Derive snapshot
  const snapshot: ToolCallStatsSnapshot = {
    toolStats: state.toolStats,
    waterfall: state.waterfall,
    totalCount: state.waterfall.length,
    runningCount: state.running.size,
  };

  return { snapshot, isDrawerOpen, toggleDrawer };
}
