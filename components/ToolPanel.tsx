"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";

export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
}

export const PRESET_NONE: string[] = [];

type ToolPreset = "none" | "full";

function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const activeNames = tools.filter(t => t.active).map(t => t.name).sort();
  const allNames = tools.map(t => t.name).sort();
  if (activeNames.join(",") === allNames.join(",")) return "full";
  return "none";
}

interface Props {
  tools: ToolEntry[];
  onPreset: (preset: ToolPreset, toolNames: string[]) => void;
  onClose: () => void;
}

interface PresetDef {
  id: ToolPreset;
  label: string;
  desc: string;
  tools?: string[];
}

const PRESETS: PresetDef[] = [
  { id: "none", label: "Off",  desc: "No tools",            tools: PRESET_NONE },
  { id: "full", label: "High", desc: "All available tools", tools: [] },
];

export function ToolPanel({ tools, onPreset, onClose }: Props) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const current = getPresetFromTools(tools);
  const currentDef = PRESETS.find(p => p.id === current) ?? PRESETS[0];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        right: 0,
        zIndex: 200,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        boxShadow: "0 -4px 20px rgba(0,0,0,0.10)",
        width: 240,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        background: "var(--bg-panel)",
        borderRadius: 8,
        padding: 3,
        gap: 3,
      }}>
        {PRESETS.map((preset) => {
          const isActive = current === preset.id;
          return (
            <button
              key={preset.id}
              onClick={() => { onPreset(preset.id, preset.id === "full" ? tools.map(t => t.name) : preset.tools ?? []); onClose(); }}
              style={{
                padding: "5px 0",
                borderRadius: 6,
                border: "none",
                background: isActive ? "var(--bg)" : "transparent",
                boxShadow: isActive ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
                color: isActive ? "var(--accent)" : "var(--text-muted)",
                fontWeight: isActive ? 600 : 400,
                fontSize: 12,
                cursor: "pointer",
                transition: "all 0.12s",
              }}
            >
              {preset.id === "none" ? t("Off") : t("High")}
            </button>
          );
        })}
      </div>

      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
        {t(currentDef.desc)}
        {current === "none" && <span> — {t("agent will not use any tools")}</span>}
      </div>

      <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
        {t("takes effect on next turn")}
      </div>
    </div>
  );
}
