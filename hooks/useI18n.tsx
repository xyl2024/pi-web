"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "en" | "zh";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  t: (key: string) => string;
}

const STORAGE_KEY = "pi-locale";

const ZH_TRANSLATIONS = {
  "Models": "模型",
  "Skills": "技能",
  "Hide sidebar": "隐藏侧边栏",
  "Show sidebar": "显示侧边栏",
  "Switch language": "切换语言",
  "Switch theme": "切换主题",
  "System": "系统",
  "System prompt is empty (tools are disabled)": "系统提示词为空（工具已禁用）",
  "Send a message to load the system prompt": "发送一条消息后加载系统提示词",
  "Select a session from the sidebar": "从侧边栏选择一个会话",
  "Get Started": "开始使用",
  "Select a project directory from the sidebar": "从侧边栏选择项目目录",
  "Add models via the Models button at the bottom": "通过底部的模型按钮添加模型",
  "No file open": "未打开文件",
  "Hide file panel": "隐藏文件面板",
  "Show file panel": "显示文件面板",
  "Branches": "分支",
  "No active session": "没有活动会话",
  "This session has no branches": "当前会话没有分支",
  "Loading session...": "正在加载会话...",
  "Running tool...": "正在运行工具...",
  "Running": "正在运行",
  "Waiting for model...": "正在等待模型...",
  "Thinking...": "正在思考...",
  "Retrying": "正在重试",
  "Agent is running...": "Agent 正在运行...",
  "Message...": "输入消息...",
  "Send": "发送",
  "Stop": "停止",
  "Steer": "插话",
  "Follow-up": "排队发送",
  "Attach image": "附加图片",
  "Change thinking level": "切换推理强度",
  "Change tool preset": "切换工具预设",
  "Stop compaction": "停止压缩",
  "Compact context": "压缩上下文",
  "Compacting...": "正在压缩...",
  "Compact": "压缩",
  "Stop agent": "停止 Agent",
  "Turn completion sound off": "关闭完成提示音",
  "Turn completion sound on": "开启完成提示音",
  "Use pi default": "沿用 pi 默认设置",
  "Disable reasoning": "关闭推理",
  "Minimal reasoning": "最少推理",
  "Low reasoning": "低强度推理",
  "Medium reasoning": "中等推理",
  "High reasoning": "高强度推理",
  "Highest reasoning": "最高强度推理",
  "No tools, chat only": "无工具，纯聊天",
  "4 built-in tools": "4 项内置工具",
  "All available tools": "全部可用工具",
  "New": "新建",
  "New session": "新会话",
  "Select a project first": "请先选择项目",
  "Refresh": "刷新",
  "Select project...": "选择项目...",
  "Use default directory": "使用默认目录",
  "Create space...": "创建空间...",
  "dir name": "目录名",
  "Creating...": "正在创建...",
  "Create": "创建",
  "Cancel": "取消",
  "Custom path...": "自定义路径...",
  "Open": "打开",
  "Loading...": "正在加载...",
  "No sessions found": "未找到会话",
  "Explorer": "资源管理器",
  "Refresh explorer": "刷新资源管理器",
  "Delete": "删除",
  "Rename": "重命名",
  "Expand forks": "展开派生会话",
  "Collapse forks": "折叠派生会话",
  "msgs": "条消息",
  "just now": "刚刚",
  "ago": "前",
  "Copy message": "复制消息",
  "Copy": "复制",
  "Copied": "已复制",
  "Edit from here": "从这里编辑",
  "Edit from here title": "从这里编辑 - 在当前会话内创建分支",
  "Creating new session": "正在创建新会话",
  "New session title": "新会话 - 从这里创建独立副本",
  "Thinking": "思考",
  "No output": "无输出",
  "copy": "复制",
  "copied": "已复制",
  "in": "输入",
  "out": "输出",
  "cache": "缓存",
  "Insert path into chat": "插入路径到聊天",
  "mention": "引用",
  "empty": "空",
  "Loading files...": "正在加载文件...",
  "No files found": "未找到文件",
  "No changes": "没有变更",
  "unchanged lines": "行未变更",
  "Failed to load image": "图片加载失败",
  "Failed to load audio": "音频加载失败",
  "lines": "行",
  "Source": "源码",
  "Diff": "差异",
  "Disable word wrap": "关闭自动换行",
  "Enable word wrap": "开启自动换行",
  "wrap": "换行",
  "Code": "代码",
  "Preview": "预览",
  "Raw": "原文",
  "HTML preview": "HTML 预览",
  "Live sync active": "实时同步已开启",
  "Not watching": "未监听",
  "live": "实时",
  "static": "静态",
  "Close": "关闭",
  "Off": "关闭",
  "Low": "低",
  "High": "高",
  "No tools": "无工具",
  "No tools enabled": "未启用工具",
  "agent will not use any tools": "Agent 不会使用任何工具",
  "takes effect on next turn": "下轮对话生效",
  "Language": "语言",
  "English": "English",
  "Chinese": "中文",
  "Steer immediately / queue follow-up...": "插话立即注入 / 追问排队发送...",
  "Interrupt the running agent and inject this message": "打断 Agent 当前运行，立即注入消息",
  "Queue this message after the agent finishes": "在 Agent 完成后排队发送",
  "Estimated tokens while streaming": "预估 token 数（流式接收中）",
  "Add Skill": "添加技能",
  "Search": "搜索",
  "Searching...": "正在搜索...",
  "global": "全局",
  "project": "项目",
  "path": "路径",
  "Name": "名称",
  "Description": "描述",
  "No skills found": "未找到技能",
  "Installed": "已安装",
  "Installing...": "正在安装...",
  "Install": "安装",
  "Select a skill": "选择一个技能",
  "Search skills hint": "搜索 skills.sh，为你的 Agent 发现并安装技能。",
  "Visible in model prompt - click to disable": "在模型提示词中可见 - 点击禁用",
  "Hidden from model prompt - click to enable": "对模型提示词隐藏 - 点击启用",
  "Provider": "提供商",
  "Model": "模型",
  "Thinking level map": "推理强度映射",
  "Cost (per million tokens)": "费用（每百万 tokens）",
  "Subscription": "订阅",
  "API Key": "API Key",
  "API override": "API 覆盖",
  "ID *": "ID *",
  "model-id": "模型 ID",
  "Display name": "显示名称",
  "inherit": "继承",
  "none": "无",
  "API key stored message": "API key 已保存。在下方输入新的 key 可以替换它，或断开连接将其移除。",
  "Enter your": "输入你的",
  "to enable": "以启用",
  "models": "个模型",
  "Opening browser...": "正在打开浏览器...",
  "Connected successfully.": "连接成功。",
  "Hide API key": "隐藏 API key",
  "Show API key": "显示 API key",
  "Search providers...": "搜索提供商...",
  "No providers match": "没有匹配的提供商",
  "Custom": "自定义",
  "OpenAI / Anthropic compatible": "OpenAI / Anthropic 兼容",
  "Custom endpoint format": "自定义端点格式",
  "Subscriptions": "订阅",
  "configured": "已配置",
  "not configured": "未配置",
  "Enter new key to replace...": "输入新 key 以替换...",
  "Removing...": "正在移除...",
  "Disconnect": "断开连接",
  "new model": "新模型",
  "Add model": "添加模型",
  "Add provider": "添加提供商",
  "Select a provider or model": "选择提供商或模型",
  "Saved": "已保存",
  "Saving...": "正在保存...",
  "Save": "保存",
} as const;

const I18nContext = createContext<I18nContextValue | null>(null);

function detectInitialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh") return saved;
  } catch {
    // ignore
  }
  return window.navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  const toggleLocale = useCallback(() => {
    setLocale(locale === "zh" ? "en" : "zh");
  }, [locale, setLocale]);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    toggleLocale,
    t: (key) => locale === "zh" ? ZH_TRANSLATIONS[key as keyof typeof ZH_TRANSLATIONS] ?? key : key,
  }), [locale, setLocale, toggleLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
