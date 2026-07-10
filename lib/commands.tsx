"use client";

import type { ReactNode } from "react";
import type { ThemePreset } from "@/hooks/useTheme";
import type { Locale } from "@/hooks/useI18n";

// ── AgentControls ────────────────────────────────────────────────────────
// Imperative controls owned by useAgentSession (inside ChatWindow). ChatWindow
// registers them on mount via setAgentControls() in sessionUiStore; AppShell
// reads them via useAgentControls() and threads them into CommandContext.
// `null` when no ChatWindow is mounted (no active session).

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ToolPresetOption = "none" | "full";

export interface AgentControls {
  switchModel: (provider: string, modelId: string) => void | Promise<void>;
  switchThinkingLevel: (level: ThinkingLevelOption) => void | Promise<void>;
  switchToolPreset: (preset: ToolPresetOption) => void | Promise<void>;
  compact: () => void | Promise<void>;
  abortStreaming: () => void | Promise<void>;
  abortCompaction: () => void | Promise<void>;
  isStreaming: boolean;
  isCompacting: boolean;
}

// ── Icons ────────────────────────────────────────────────────────────────
// 16×16 inline SVGs in the project's house style: stroke 2, currentColor,
// round caps. One component per icon so commands can keep `icon: <PlusIcon />`.

const I = (children: ReactNode) => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
  >
    {children}
  </svg>
);

const PlusIcon = () => I(<><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>);
const StopIcon = () => I(<rect x="6" y="6" width="12" height="12" rx="1" />);
const CompressIcon = () => I(<><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></>);
const SunIcon = () => I(<><circle cx="12" cy="12" r="4" /><line x1="12" y1="2" x2="12" y2="5" /><line x1="12" y1="19" x2="12" y2="22" /><line x1="4.22" y1="4.22" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.78" y2="19.78" /><line x1="2" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="22" y2="12" /><line x1="4.22" y1="19.78" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.78" y2="4.22" /></>);
const MoonIcon = () => I(<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />);
const TreeIcon = () => I(<><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></>);
const MountainIcon = () => I(<><path d="M3 20l6-12 4 8 3-6 5 10" /></>);
const FlameIcon = () => I(<path d="M12 2c2 4-2 6 0 9 2 3 5 2 5 6a5 5 0 0 1-10 0c0-3 2-4 2-7 0-3-1-5 3-8z" />);
const BrainIcon = () => I(<><path d="M9 4a3 3 0 0 0-3 3v0a3 3 0 0 0-3 3v1a3 3 0 0 0 1 2.2A3 3 0 0 0 3 16v0a3 3 0 0 0 3 3h0a3 3 0 0 0 3-3" /><path d="M15 4a3 3 0 0 1 3 3v0a3 3 0 0 1 3 3v1a3 3 0 0 1-1 2.2A3 3 0 0 1 21 16v0a3 3 0 0 1-3 3h0a3 3 0 0 1-3-3" /><line x1="12" y1="4" x2="12" y2="19" /></>);
const ToolIcon = () => I(<><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-7 7 2.6 2.6 7-7a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-2.4 2.3-2.7z" /></>);
const SidebarIcon = () => I(<><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></>);
const PanelRightIcon = () => I(<><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" /></>);
const FocusIcon = () => I(<><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></>);
const CheckIcon = () => I(<polyline points="20 6 9 17 4 12" />);
const CanvasIcon = () => I(<><path d="M3 17l4-4 3 3 7-7 4 4" /><circle cx="6" cy="6" r="2" /></>);
const StarIcon = () => I(<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />);
const GlobeIcon = () => I(<><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z" /></>);
const TerminalIcon = () => I(<><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>);
const HttpIcon = () => I(<><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z" /></>);
const BracesIcon = () => I(<><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" /><path d="M16 21h1a2 2 0 0 0 2-2v-4a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" /></>);
const GearIcon = () => I(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>);
const ChipIcon = () => I(<><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" /><line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" /><line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" /><line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" /></>);
const SparkleIcon = () => I(<><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" /></>);
const BookIcon = () => I(<><path d="M4 19.5V4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 1 4 17.5" /><path d="M8 7h8" /><path d="M8 11h6" /></>);

const ClockIcon = () => I(<><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></>);
const LangIcon = () => I(<><path d="M5 8h14" /><path d="M8 5h7" /><path d="M11 12c0 4-3 7-6 7" /><path d="M11 12c0 4 3 7 6 7" /><path d="M9 19l3-7 3 7" /></>);
const DiffIcon = () => I(<><rect x="3" y="4" width="8" height="16" rx="1.5" /><rect x="13" y="4" width="8" height="16" rx="1.5" /><line x1="7" y1="9" x2="7" y2="9" /><line x1="17" y1="13" x2="17" y2="13" /></>);
const WalletIcon = () => I(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18" /><circle cx="16.5" cy="14" r="1.2" fill="currentColor" stroke="none" /></>);

// Theme icons picked from PRESET_IS_DARK to give the swatch a hint.
const ThemeIcon = ({ preset }: { preset: ThemePreset }) => {
  switch (preset) {
    case "default": return <SunIcon />;
    case "midnight": return <MoonIcon />;
    case "synthwave": return <FlameIcon />;
    case "forest": return <TreeIcon />;
    case "sepia": return <MountainIcon />;
  }
};

// ── CommandGroup ─────────────────────────────────────────────────────────
// Order matters — empty-state renders groups top-to-bottom in this sequence.

export const COMMAND_GROUPS = [
  "Session",
  "Theme",
  "Model",
  "Thinking",
  "Tools",
  "View",
  "Panel",
  "Modal",
  "Language",
] as const;

export type CommandGroup = (typeof COMMAND_GROUPS)[number];

// ── Command ──────────────────────────────────────────────────────────────

export interface Command {
  id: string;
  title: string;          // already resolved via t() at build time
  group: CommandGroup;
  keywords?: string[];    // English-only, used for fuzzy matching
  icon: ReactNode;
  shortcut?: string;      // display-only
  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void | Promise<void>;
}

// ── CommandContext ───────────────────────────────────────────────────────
// Everything a command might call. Built by AppShell and passed into
// buildCommands() then into CommandPalette. Re-creating the object is fine
// — CommandPalette is unmounted while it's being re-created, and the
// commands are filtered/sorted per build.

export interface CommandContext {
  // Theme / language
  setTheme: (preset: ThemePreset) => void;
  setLocale: (locale: Locale) => void;

  // Session lifecycle
  newSession: () => void;

  // Modal openers
  openSettings: () => void;
  openModels: () => void;
  openSkills: () => void;
  openPrompts: () => void;
  openScheduler: () => void;

  // Right-panel tabs
  openTodosTab: () => void;
  openFavoritesTab: () => void;
  openCanvasTab: () => void;
  openTranslateTab: () => void;
  openToolCallsTab: () => void;
  openHttpTab: () => void;
  openJsonTab: () => void;
  openDiffTab: () => void;
  openFinanceTab: () => void;

  // View toggles
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  toggleFocus: () => void;

  // Imperative agent controls — null when no ChatWindow is mounted.
  agentControls: AgentControls | null;

  // Cwd/session presence for when() predicates.
  hasSession: boolean;
  hasCwd: boolean;
}

// ── Theme metadata (for buildCommands) ──────────────────────────────────

interface BuildOptions {
  t: (key: string) => string;
  models: Array<{ id: string; name: string; provider: string }>;
}

// ── buildCommands ────────────────────────────────────────────────────────

export function buildCommands(ctx: CommandContext, opts: BuildOptions): Command[] {
  const { t, models } = opts;
  const cmds: Command[] = [];

  // ── Session ──
  cmds.push({
    id: "session.new",
    title: t("New session"),
    group: "Session",
    keywords: ["session", "chat", "new", "create", "新建", "会话"],
    icon: <PlusIcon />,
    run: () => ctx.newSession(),
  });

  cmds.push({
    id: "session.compact",
    title: t("Compact session"),
    group: "Session",
    keywords: ["compact", "context", "summarize", "压缩", "上下文"],
    icon: <CompressIcon />,
    when: (c) => c.hasSession && !!c.agentControls && !c.agentControls.isStreaming && !c.agentControls.isCompacting,
    run: () => ctx.agentControls?.compact(),
  });

  cmds.push({
    id: "session.abort_streaming",
    title: t("Stop agent"),
    group: "Session",
    keywords: ["stop", "abort", "cancel", "停止", "中止"],
    icon: <StopIcon />,
    when: (c) => !!c.agentControls?.isStreaming,
    run: () => ctx.agentControls?.abortStreaming(),
  });

  cmds.push({
    id: "session.abort_compaction",
    title: t("Stop compaction"),
    group: "Session",
    keywords: ["stop", "abort", "cancel", "compaction", "停止", "压缩"],
    icon: <StopIcon />,
    when: (c) => !!c.agentControls?.isCompacting,
    run: () => ctx.agentControls?.abortCompaction(),
  });

  // ── Theme (5) ──
  const themes: ThemePreset[] = ["default", "midnight", "synthwave", "forest", "sepia"];
  const themeTitleKeys: Record<ThemePreset, string> = {
    default: "Theme: Default",
    midnight: "Theme: Midnight",
    synthwave: "Theme: Synthwave",
    forest: "Theme: Forest",
    sepia: "Theme: Sepia",
  };
  const themeKeywords: Record<ThemePreset, string[]> = {
    default: ["theme", "default", "light", "主题", "默认", "浅色"],
    midnight: ["theme", "midnight", "dark", "主题", "夜晚", "深色"],
    synthwave: ["theme", "synthwave", "neon", "purple", "主题", "霓虹"],
    forest: ["theme", "forest", "green", "主题", "森林", "绿色"],
    sepia: ["theme", "sepia", "warm", "主题", "复古", "暖色"],
  };
  for (const preset of themes) {
    cmds.push({
      id: `theme.${preset}`,
      title: t(themeTitleKeys[preset]),
      group: "Theme",
      keywords: themeKeywords[preset],
      icon: <ThemeIcon preset={preset} />,
      run: () => ctx.setTheme(preset),
    });
  }

  // ── Model (dynamic) ──
  // One command per (provider, modelId). Model id strings are provider-specific
  // (e.g. "claude-sonnet-4-6"); include both provider and name as keywords so
  // "claude" / "sonnet" / "zenmux" all find it.
  for (const m of models) {
    const modelTitle = `${m.name}`;
    cmds.push({
      id: `model.${m.provider}.${m.id}`,
      title: modelTitle,
      group: "Model",
      keywords: [m.provider, m.id, m.name.toLowerCase(), "model", "模型"],
      icon: <ChipIcon />,
      when: (c) => c.hasSession && !!c.agentControls,
      run: () => ctx.agentControls?.switchModel(m.provider, m.id),
    });
  }

  // ── Thinking (7) ──
  const thinkingLevels: ThinkingLevelOption[] = ["auto", "off", "minimal", "low", "medium", "high", "xhigh"];
  const thinkingTitleKeys: Record<ThinkingLevelOption, string> = {
    auto: "Thinking: Auto",
    off: "Thinking: Off",
    minimal: "Thinking: Minimal",
    low: "Thinking: Low",
    medium: "Thinking: Medium",
    high: "Thinking: High",
    xhigh: "Thinking: Extra High",
  };
  const thinkingKeywords: Record<ThinkingLevelOption, string[]> = {
    auto: ["thinking", "reasoning", "auto", "推理", "自动"],
    off: ["thinking", "reasoning", "off", "none", "推理", "关闭"],
    minimal: ["thinking", "reasoning", "minimal", "推理", "最少"],
    low: ["thinking", "reasoning", "low", "推理", "低"],
    medium: ["thinking", "reasoning", "medium", "推理", "中"],
    high: ["thinking", "reasoning", "high", "推理", "高"],
    xhigh: ["thinking", "reasoning", "xhigh", "extra", "max", "推理", "最高"],
  };
  for (const lvl of thinkingLevels) {
    cmds.push({
      id: `thinking.${lvl}`,
      title: t(thinkingTitleKeys[lvl]),
      group: "Thinking",
      keywords: thinkingKeywords[lvl],
      icon: <BrainIcon />,
      when: (c) => c.hasSession && !!c.agentControls,
      run: () => ctx.agentControls?.switchThinkingLevel(lvl),
    });
  }

  // ── Tools (2) ──
  cmds.push({
    id: "tools.none",
    title: t("Tools: None"),
    group: "Tools",
    keywords: ["tools", "none", "off", "disable", "工具", "无", "关闭"],
    icon: <ToolIcon />,
    when: (c) => c.hasSession && !!c.agentControls,
    run: () => ctx.agentControls?.switchToolPreset("none"),
  });
  cmds.push({
    id: "tools.full",
    title: t("Tools: Full"),
    group: "Tools",
    keywords: ["tools", "full", "all", "enable", "工具", "全部", "启用"],
    icon: <ToolIcon />,
    when: (c) => c.hasSession && !!c.agentControls,
    run: () => ctx.agentControls?.switchToolPreset("full"),
  });

  // ── View (3) ──
  cmds.push({
    id: "view.sidebar",
    title: t("Toggle sidebar"),
    group: "View",
    keywords: ["sidebar", "panel", "left", "toggle", "侧边栏", "显示", "隐藏"],
    icon: <SidebarIcon />,
    shortcut: "⌘B",
    run: () => ctx.toggleSidebar(),
  });
  cmds.push({
    id: "view.right_panel",
    title: t("Toggle right panel"),
    group: "View",
    keywords: ["right", "panel", "toggle", "右", "面板"],
    icon: <PanelRightIcon />,
    shortcut: "⌘⌥B",
    run: () => ctx.toggleRightPanel(),
  });
  cmds.push({
    id: "view.focus",
    title: t("Toggle focus mode"),
    group: "View",
    keywords: ["focus", "zen", "distraction", "专注", "免打扰"],
    icon: <FocusIcon />,
    run: () => ctx.toggleFocus(),
  });

  // ── Panel (7) ──
  cmds.push({
    id: "panel.todo",
    title: t("Open todos"),
    group: "Panel",
    keywords: ["todo", "task", "待办", "任务"],
    icon: <CheckIcon />,
    run: () => ctx.openTodosTab(),
  });
  cmds.push({
    id: "panel.canvas",
    title: t("Open canvas"),
    group: "Panel",
    keywords: ["canvas", "draw", "excalidraw", "whiteboard", "画布", "白板"],
    icon: <CanvasIcon />,
    run: () => ctx.openCanvasTab(),
  });
  cmds.push({
    id: "panel.favorites",
    title: t("Open favorites"),
    group: "Panel",
    keywords: ["favorite", "star", "collection", "收藏", "星标"],
    icon: <StarIcon />,
    run: () => ctx.openFavoritesTab(),
  });
  cmds.push({
    id: "panel.translate",
    title: t("Open translate"),
    group: "Panel",
    keywords: ["translate", "translation", "翻译"],
    icon: <GlobeIcon />,
    run: () => ctx.openTranslateTab(),
  });
  cmds.push({
    id: "panel.toolcalls",
    title: t("Open tool calls"),
    group: "Panel",
    keywords: ["tool", "calls", "stats", "工具", "调用", "统计"],
    icon: <TerminalIcon />,
    run: () => ctx.openToolCallsTab(),
  });
  cmds.push({
    id: "panel.http",
    title: t("Open HTTP debug"),
    group: "Panel",
    keywords: ["http", "api", "debug", "request", "调试", "请求"],
    icon: <HttpIcon />,
    run: () => ctx.openHttpTab(),
  });
  cmds.push({
    id: "panel.json",
    title: t("Open JSON formatter"),
    group: "Panel",
    keywords: ["json", "format", "格式化"],
    icon: <BracesIcon />,
    run: () => ctx.openJsonTab(),
  });
  cmds.push({
    id: "panel.diff",
    title: t("Open Diff"),
    group: "Panel",
    keywords: ["diff", "compare", "text", "差异", "对比", "文本"],
    icon: <DiffIcon />,
    run: () => ctx.openDiffTab(),
  });
  cmds.push({
    id: "panel.finance",
    title: t("Open Finance"),
    group: "Panel",
    keywords: ["finance", "money", "expense", "income", "记账", "支出", "收入"],
    icon: <WalletIcon />,
    run: () => ctx.openFinanceTab(),
  });

  // ── Modal (5) ──
  cmds.push({
    id: "modal.settings",
    title: t("Open settings"),
    group: "Modal",
    keywords: ["settings", "preferences", "config", "设置", "偏好", "配置"],
    icon: <GearIcon />,
    run: () => ctx.openSettings(),
  });
  cmds.push({
    id: "modal.models",
    title: t("Open models config"),
    group: "Modal",
    keywords: ["models", "config", "providers", "api", "模型", "配置", "服务商"],
    icon: <ChipIcon />,
    run: () => ctx.openModels(),
  });
  cmds.push({
    id: "modal.skills",
    title: t("Open skills"),
    group: "Modal",
    keywords: ["skills", "extensions", "技能", "扩展"],
    icon: <SparkleIcon />,
    when: (c) => c.hasCwd,
    run: () => ctx.openSkills(),
  });
  cmds.push({
    id: "modal.prompts",
    title: t("Open prompts"),
    group: "Modal",
    keywords: ["prompts", "templates", "slash", "提示词", "模板"],
    icon: <BookIcon />,
    when: (c) => c.hasCwd,
    run: () => ctx.openPrompts(),
  });
  cmds.push({
    id: "modal.scheduler",
    title: t("Open scheduled tasks"),
    group: "Modal",
    keywords: ["scheduler", "cron", "schedule", "timer", "tasks", "定时", "任务", "定时任务"],
    icon: <ClockIcon />,
    run: () => ctx.openScheduler(),
  });

  // ── Language (2) ──
  cmds.push({
    id: "lang.en",
    title: t("Language: English"),
    group: "Language",
    keywords: ["language", "english", "en", "语言", "英文"],
    icon: <LangIcon />,
    run: () => ctx.setLocale("en"),
  });
  cmds.push({
    id: "lang.zh",
    title: t("Language: Chinese"),
    group: "Language",
    keywords: ["language", "chinese", "zh", "中文", "语言"],
    icon: <LangIcon />,
    run: () => ctx.setLocale("zh"),
  });

  // Apply when() to filter the empty-state view too.
  return cmds.filter((c) => !c.when || c.when(ctx));
}

// Helper for fuzzy scoring of a single command against a query.
// Returns -1 if the command doesn't match at all; higher scores are better.
export function scoreCommand(cmd: Command, query: string): number {
  if (!query) return 0; // empty query: caller handles non-match separately
  const q = query.toLowerCase();

  // Exact title match wins big.
  if (cmd.title.toLowerCase() === q) return 1000;

  // Title prefix match.
  if (cmd.title.toLowerCase().startsWith(q)) return 500;

  // Title contains.
  const titleLower = cmd.title.toLowerCase();
  if (titleLower.includes(q)) return 200 + (titleLower.indexOf(q) === 0 ? 50 : 0);

  // Keyword exact match.
  for (const k of cmd.keywords ?? []) {
    if (k.toLowerCase() === q) return 400;
  }

  // Fuzzy subsequence match across title + keywords.
  const haystack = [cmd.title.toLowerCase(), ...(cmd.keywords ?? []).map((k) => k.toLowerCase())];
  let best = -1;
  for (const h of haystack) {
    const s = fuzzyScore(h, q);
    if (s > best) best = s;
  }
  return best;
}

// Simple subsequence fuzzy score: returns 0-100 if all query chars appear
// in order, else -1. Consecutive matches score higher; earlier matches too.
function fuzzyScore(haystack: string, needle: string): number {
  let hi = 0;
  let ni = 0;
  let score = 0;
  let prevMatch = -1;
  while (hi < haystack.length && ni < needle.length) {
    if (haystack[hi] === needle[ni]) {
      score += 10;
      if (prevMatch === hi - 1) score += 5; // consecutive bonus
      if (hi < 3) score += 3; // word-start bonus
      prevMatch = hi;
      ni++;
    }
    hi++;
  }
  if (ni < needle.length) return -1;
  // Penalize long haystacks slightly so "Theme: Midnight" doesn't always
  // outrank "Theme: Default" when typing "def".
  score -= Math.floor(haystack.length / 10);
  return score;
}