"use client";

import React, { useRef, useState, useCallback, useEffect, useImperativeHandle, forwardRef, KeyboardEvent, useMemo } from "react";
import { useI18n, type Locale } from "@/hooks/useI18n";
import { Tooltip } from "./Tooltip";
import { IconHoverButton } from "./IconHoverButton";
import { ProviderIcon } from "./ProviderIcon";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

export interface SlashResource {
  source: "prompt" | "skill" | "action";
  name: string;
  command: string;
  description: string;
  argumentHint?: string;
  path: string;
  location?: string;
  content: string;
}

interface Props {
  onSend: (message: string, images?: AttachedImage[]) => void;
  onAbort: () => void;
  isStreaming: boolean;
  model?: { provider: string; modelId: string } | null;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string }[];
  onModelChange?: (provider: string, modelId: string) => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  toolPreset?: "none" | "full";
  onToolPresetChange?: (preset: "none" | "full") => void;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  onExport?: () => void;
  isExporting?: boolean;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  slashResources?: SlashResource[];
  slashResourceKey?: string;
  onSlashAction?: (action: string) => void;
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  onNewSession?: () => void;
  onOpenReplay?: () => void;
  replayAvailable?: boolean;
  sessionId?: string | null;
  /** Text of the session's first user message (string or first text block). null disables the auto-name button. */
  firstUserMessageText?: string | null;
  /** Current session_info.name (may be unset for never-named sessions). */
  currentSessionName?: string | null;
  /** Fired after the auto-name PATCH succeeds — used to refresh the sidebar list. */
  onRenameCompleted?: (name: string) => void | Promise<void>;
  /** Fired as soon as the rename is committed — keeps parent state in sync. */
  onSessionNameChange?: (name: string) => void;
  /**
   * Plain-text user messages from the active session, oldest first. Sourced
   * from `useAgentSession.messages` (which reflects the backend .jsonl) so
   * ArrowUp recall matches the real conversation history across refreshes
   * and devices. Used by the input history navigation in handleKeyDown.
   */
  userMessageHistory?: string[];
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  addImages: (files: File[]) => void;
  focus: () => void;
}

const TOOL_PRESETS = ["off", "full"] as const;
const TOOL_PRESET_MAP: Record<"off" | "full", "none" | "full"> = { off: "none", full: "full" };

const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
// Border color reflects the active reasoning intensity: gray = off, then a
// cool-to-warm gradient up to red for xhigh. "auto" falls back to the
// neutral border because the UI can't know which level the upstream pi
// actually resolved to.
const THINKING_BORDER_COLOR: Record<typeof THINKING_LEVELS[number], string> = {
  auto: "color-mix(in srgb, var(--border) 70%, transparent)",
  off: "rgba(148,163,184,0.55)",   // slate-400
  minimal: "rgba(56,189,248,0.55)", // sky-400
  low: "rgba(59,130,246,0.55)",    // blue-500
  medium: "rgba(139,92,246,0.55)",  // violet-500
  high: "rgba(249,115,22,0.55)",    // orange-500
  xhigh: "rgba(239,68,68,0.55)",    // red-500
};
const SLASH_PAGE_SIZE = 5;

const BUILTIN_NEW_SESSION: SlashResource = {
  source: "action",
  name: "New session",
  command: "new",
  description: "新建会话",
  path: "",
  content: "",
};

const TYPEWRITER_PHRASES: Record<Locale, string[]> = {
  en: [
    "ready when you are.",
    "ask me anything.",
    "let's build something cool.",
    "explore your codebase.",
    "draft an email.",
    "summarize that paper.",
    "plan your weekend.",
    "explain it like I'm five.",
    "pair-program with me.",
    "fix that pesky bug.",
    "translate to Chinese.",
    "write a haiku.",
    "brainstorm ideas.",
    "review my pull request.",
    "what should we cook tonight?",
    "ship it.",
    "make it pretty.",
    "talk it through with me.",
    "code is poetry.",
    "the cursor blinks back.",
    "draft in moonlight.",
    "let the code breathe.",
    "trace the river.",
    "a small, kind fix.",
    "morning, again.",
    "leave room for wonder.",
    "where the light lands.",
  ],
  zh: [
    "我准备好了。",
    "随时问我任何问题。",
    "一起做点有趣的东西。",
    "探索你的代码库。",
    "帮你起草一封邮件。",
    "总结那篇论文。",
    "规划你的周末。",
    "像讲给五岁小孩一样解释。",
    "和我一起结对编程。",
    "修掉那个烦人的 bug。",
    "翻译成中文。",
    "写一首俳句。",
    "一起头脑风暴。",
    "帮我 review 这个 PR。",
    "今晚吃什么？",
    "发版吧。",
    "把它变好看。",
    "陪我梳理一下思路。",
    "今晚月色真好。",
    "行到水穷处，坐看云起时。",
    "此心安处是吾乡。",
    "把酒祝东风。",
    "留白处，自有山河。",
    "春风又绿江南岸。",
    "人间有味是清欢。",
    "落霞与孤鹜齐飞。",
  ],
};

function Typewriter({ phrases }: { phrases: string[] }) {
  const [phraseIdx, setPhraseIdx] = useState(() => Math.floor(Math.random() * phrases.length));
  const [text, setText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [caretOn, setCaretOn] = useState(true);

  useEffect(() => {
    const blink = setInterval(() => setCaretOn((v) => !v), 530);
    return () => clearInterval(blink);
  }, []);

  useEffect(() => {
    const current = phrases[phraseIdx];
    let timeout: ReturnType<typeof setTimeout>;
    if (!deleting && text === current) {
      timeout = setTimeout(() => setDeleting(true), 1800);
    } else if (deleting && text === "") {
      setDeleting(false);
      setPhraseIdx((i) => {
        if (phrases.length <= 1) return i;
        let next = Math.floor(Math.random() * phrases.length);
        while (next === i) next = Math.floor(Math.random() * phrases.length);
        return next;
      });
    } else {
      const next = deleting ? current.slice(0, text.length - 1) : current.slice(0, text.length + 1);
      timeout = setTimeout(() => setText(next), deleting ? 28 : 55);
    }
    return () => clearTimeout(timeout);
  }, [text, deleting, phraseIdx, phrases]);

  return (
    <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
      {text}
      <span style={{ opacity: caretOn ? 1 : 0, color: "var(--accent)", marginLeft: 1 }}>▍</span>
    </span>
  );
}

function getSlashQuery(value: string, cursor: number): { start: number; query: string } | null {
  if (cursor === 0 || value[0] !== "/") return null;
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/^\/([^\s/]*)$/);
  if (!match) return null;
  return {
    start: 0,
    query: match[1],
  };
}

function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: "\"" | "'" | null = null;

  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === "\"" || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) args.push(current);
  return args;
}

function substitutePromptArgs(content: string, args: string[]): string {
  let result = content;
  result = result.replace(/\$(\d+)/g, (_, num: string) => args[parseInt(num, 10) - 1] ?? "");
  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr: string, lengthStr?: string) => {
    const start = Math.max(0, parseInt(startStr, 10) - 1);
    if (lengthStr) return args.slice(start, start + parseInt(lengthStr, 10)).join(" ");
    return args.slice(start).join(" ");
  });
  const allArgs = args.join(" ");
  result = result.replace(/\$ARGUMENTS/g, allArgs);
  result = result.replace(/\$@/g, allArgs);
  return result;
}

function hasPromptArgPlaceholder(content: string): boolean {
  return /\$(\d+|@|ARGUMENTS)|\$\{@:\d+(?::\d+)?\}/.test(content);
}

function formatSlashContent(item: SlashResource, argsString = "", appendUnusedArgs = false): string {
  const content = item.content.trim();
  if (item.source === "prompt") {
    const expanded = substitutePromptArgs(content, parseCommandArgs(argsString));
    const args = argsString.trim();
    if (appendUnusedArgs && args && !hasPromptArgPlaceholder(content)) {
      return `${expanded}\n\n${args}`;
    }
    return expanded;
  }

  const name = item.name.replace(/"/g, "&quot;");
  const skillReference = `Use this skill: ${name}`;
  const args = argsString.trim();
  return args ? `${args}\n\n${skillReference}` : skillReference;
}

function findDirectSlashResource(message: string, resources: SlashResource[]): { item: SlashResource; args: string } | null {
  const match = message.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  const command = match[1];
  const item = resources.find((resource) => resource.command === command);
  if (!item) return null;

  return { item, args: match[2] ?? "" };
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, isStreaming, model, modelNames, modelList, onModelChange,
  onCompact, onAbortCompaction, isCompacting, compactError, toolPreset, onToolPresetChange,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo,
  slashResources = [], slashResourceKey,
  onSlashAction,
  contextUsage,
  onNewSession,
  onOpenReplay,
  replayAvailable,
  onExport, isExporting, sessionId,
  firstUserMessageText,
  currentSessionName,
  onRenameCompleted,
  onSessionNameChange,
  userMessageHistory,
}: Props, ref) {
  const { t, locale } = useI18n();
  const [value, setValue] = useState("");
  const [cursorPosition, setCursorPosition] = useState(0);
  const [isFocused, setIsFocused] = useState(false);
  const [selectedSlashResource, setSelectedSlashResource] = useState<SlashResource | null>(null);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashPage, setSlashPage] = useState(0);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);

  // Input history index: `historyIndex` is null when the user is NOT
  // browsing history (regular draft editing). `draftBeforeHistory` is the
  // value the textarea had at the moment the user first pressed ArrowUp;
  // ArrowDown past the newest entry restores it. The actual list of
  // historical messages comes from the `userMessageHistory` prop (sourced
  // from the backend .jsonl via useAgentSession).
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [draftBeforeHistory, setDraftBeforeHistory] = useState("");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const toolDropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Confirm/toast hooks for the auto-name flow.
  const confirm = useConfirm();
  const toast = useToast();
  // Tracks the brief in-progress POST + PATCH pair so the button can disable +
  // show a "Naming..." label while the network round-trip is happening.
  const [isAutoNaming, setIsAutoNaming] = useState(false);
  // Holds the most-recently-generated name so the toolbar button can briefly
  // display it instead of the usual icon for ~3s after a successful rename.
  const [autoNamedDisplay, setAutoNamedDisplay] = useState<string | null>(null);
  const autoNamedDisplayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (autoNamedDisplayTimerRef.current) {
      clearTimeout(autoNamedDisplayTimerRef.current);
      autoNamedDisplayTimerRef.current = null;
    }
  }, []);

  const slashQuery = useMemo(() => getSlashQuery(value, cursorPosition), [value, cursorPosition]);
  const filteredSlashResources = useMemo(() => {
    if (!slashMenuOpen || !slashQuery) return [];
    const q = slashQuery.query.toLowerCase();
    const builtinMatch =
      BUILTIN_NEW_SESSION.command.toLowerCase().includes(q) ||
      BUILTIN_NEW_SESSION.name.toLowerCase().includes(q) ||
      BUILTIN_NEW_SESSION.description.toLowerCase().includes(q);
    const matches = slashResources.filter((item) => {
      return item.command.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q);
    });
    return builtinMatch ? [BUILTIN_NEW_SESSION, ...matches] : matches;
  }, [slashMenuOpen, slashQuery, slashResources]);
  const slashPageCount = Math.max(1, Math.ceil(filteredSlashResources.length / SLASH_PAGE_SIZE));
  const slashCurrentPage = Math.min(slashPage, slashPageCount - 1);
  const visibleSlashResources = useMemo(() => {
    const start = slashCurrentPage * SLASH_PAGE_SIZE;
    return filteredSlashResources.slice(start, start + SLASH_PAGE_SIZE);
  }, [filteredSlashResources, slashCurrentPage]);

  useEffect(() => {
    setSelectedSlashResource(null);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    setSlashPage(0);
  }, [slashResourceKey]);

  // Reset the history index when the session changes so the user starts in
  // "regular draft" mode every time they switch sessions — otherwise
  // pressing ArrowUp in a new session could still be inside the previous
  // session's index. The `userMessageHistory` prop is already derived from
  // the current session, so no manual reload is needed.
  useEffect(() => {
    setHistoryIndex(null);
    setDraftBeforeHistory("");
  }, [sessionId]);

  useEffect(() => {
    setSlashActiveIndex(0);
    setSlashPage(0);
  }, [slashQuery?.query, slashResources]);

  useEffect(() => {
    setSlashPage((page) => Math.min(page, slashPageCount - 1));
  }, [slashPageCount]);

  useEffect(() => {
    setSlashActiveIndex((index) => Math.min(index, Math.max(0, visibleSlashResources.length - 1)));
  }, [visibleSlashResources.length]);

  const selectedPromptResource = selectedSlashResource?.source === "prompt" ? selectedSlashResource : null;
  const selectedPromptPreview = selectedPromptResource
    ? formatSlashContent(selectedPromptResource, value.trim())
    : null;

  useImperativeHandle(ref, () => ({
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim()) return;
      setValue(text);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const newVal = before + sep + text + after;
      setValue(newVal);
      requestAnimationFrame(() => {
        if (!ta) return;
        const pos = start + sep.length + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    addImages(files: File[]) {
      processImageFiles(files);
    },
    focus() {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      // Place cursor at end of current text
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
    },
  }));

  const processImageFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const newImages = await Promise.all(
      imageFiles.map(
        (file) =>
          new Promise<AttachedImage>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result as string;
              // result is "data:<mime>;base64,<data>"
              const base64 = result.split(",")[1];
              resolve({ data: base64, mimeType: file.type, previewUrl: URL.createObjectURL(file) });
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          })
      )
    );
    setAttachedImages((prev) => [...prev, ...newImages]);
  }, []);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      URL.revokeObjectURL(next[index].previewUrl);
      next.splice(index, 1);
      return next;
    });
  }, []);

  const clearImages = useCallback(() => {
    setAttachedImages((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      return [];
    });
  }, []);

  // Fill the input box with a recalled history entry: replace `value`, drop
  // any attached images (Q8: prevent accidental re-send of last turn's
  // images), and place the caret at the end (Q7).
  const fillFromHistory = useCallback((text: string) => {
    setValue(text);
    setCursorPosition(text.length);
    setAttachedImages((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      return [];
    });
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  const buildMessage = useCallback((rawMessage: string) => {
    const msg = rawMessage.trim();
    if (selectedSlashResource) {
      return formatSlashContent(selectedSlashResource, msg, true);
    }

    const directSlash = findDirectSlashResource(msg, slashResources);
    if (directSlash) {
      return formatSlashContent(directSlash.item, directSlash.args);
    }

    return msg;
  }, [selectedSlashResource, slashResources]);

  const handleSend = useCallback(() => {
    const msg = buildMessage(value);
    if (!msg && !attachedImages.length) return;
    if (isStreaming) return;
    onSend(msg, attachedImages.length ? attachedImages : undefined);
    // No need to record locally — `useAgentSession.handleSend` already
    // pushes the message into its `messages` state, which feeds
    // `userMessageHistory` on the next render. Reset the local index so
    // the next ArrowUp starts a fresh recall.
    setHistoryIndex(null);
    setDraftBeforeHistory("");
    setValue("");
    setCursorPosition(0);
    setSelectedSlashResource(null);
    setSlashMenuOpen(false);
    clearImages();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, attachedImages, isStreaming, onSend, clearImages, buildMessage]);

  // LLM-driven session name generation. Asks the dedicated suggest endpoint
  // for a name, then writes it via the existing PATCH route. The button stays
  // disabled (gated by canAutoName) until the first user message is usable
  // and the agent isn't streaming — see JSX below.
  const handleAutoName = useCallback(async () => {
    if (!sessionId) return;
    if (isAutoNaming) return;
    if (isStreaming) return;
    if (!firstUserMessageText || !firstUserMessageText.trim()) return;

    if (currentSessionName && currentSessionName.trim()) {
      const ok = await confirm({
        title: t("Auto-name session?"),
        description: t("This will replace the current session name."),
        confirmLabel: t("Auto-name"),
        cancelLabel: t("Cancel"),
        destructive: false,
      });
      if (!ok) return;
    }

    setIsAutoNaming(true);
    try {
      const suggestRes = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/auto-name`,
        { method: "POST" },
      );
      const suggestBody = (await suggestRes.json().catch(() => ({}))) as {
        name?: unknown;
        error?: unknown;
      };
      if (!suggestRes.ok || typeof suggestBody.name !== "string") {
        const reason = typeof suggestBody.error === "string" ? suggestBody.error : `HTTP ${suggestRes.status}`;
        throw new Error(reason);
      }
      const name = suggestBody.name.trim();
      if (!name) {
        toast.show({ kind: "error", message: t("Auto-naming returned an empty name") });
        return;
      }

      const patchRes = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      if (!patchRes.ok) {
        const body = (await patchRes.json().catch(() => ({}))) as { error?: unknown };
        const reason = typeof body.error === "string" ? body.error : `HTTP ${patchRes.status}`;
        throw new Error(reason);
      }

      onSessionNameChange?.(name);
      try { await onRenameCompleted?.(name); } catch { /* sidebar refresh is best-effort */ }
      toast.show({ kind: "success", message: `${t("Renamed")} ${name}` });

      setAutoNamedDisplay(name);
      if (autoNamedDisplayTimerRef.current) clearTimeout(autoNamedDisplayTimerRef.current);
      autoNamedDisplayTimerRef.current = setTimeout(() => {
        setAutoNamedDisplay(null);
        autoNamedDisplayTimerRef.current = null;
      }, 3000);
    } catch (error) {
      toast.show({
        kind: "error",
        message: `${t("Auto-naming failed")}: ${
          error instanceof Error && error.message ? error.message : t("Network error")
        }`,
      });
    } finally {
      setIsAutoNaming(false);
    }
  }, [
    sessionId,
    isAutoNaming,
    isStreaming,
    firstUserMessageText,
    currentSessionName,
    confirm,
    toast,
    onSessionNameChange,
    onRenameCompleted,
    t,
  ]);

  const selectSlashResource = useCallback((item: SlashResource) => {
    if (item.source === "action") {
      onSlashAction?.(item.command);
      setValue("");
      setCursorPosition(0);
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      setSlashPage(0);
      setSelectedSlashResource(null);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.focus();
      }
      return;
    }

    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? cursorPosition;
    const query = getSlashQuery(value, cursor);
    const nextValue = query
      ? value.slice(0, query.start) + value.slice(cursor)
      : value;

    setSelectedSlashResource(item);
    setValue(nextValue);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    setSlashPage(0);

    requestAnimationFrame(() => {
      const nextCursor = query ? query.start : cursor;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextCursor, nextCursor);
      setCursorPosition(nextCursor);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, [cursorPosition, value, onSlashAction]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (selectedSlashResource && e.shiftKey && e.key === "Backspace") {
        e.preventDefault();
        setSelectedSlashResource(null);
        return;
      }

      if (slashMenuOpen && slashQuery && visibleSlashResources.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex((i) => (i + 1) % visibleSlashResources.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex((i) => (i - 1 + visibleSlashResources.length) % visibleSlashResources.length);
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setSlashPage((page) => Math.min(page + 1, slashPageCount - 1));
          setSlashActiveIndex(0);
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setSlashPage((page) => Math.max(page - 1, 0));
          setSlashActiveIndex(0);
          return;
        }
        if ((e.key === " " || e.code === "Space") && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          selectSlashResource(visibleSlashResources[slashActiveIndex] ?? visibleSlashResources[0]);
          return;
        }
      }
      if (slashMenuOpen && e.key === "Escape") {
        e.preventDefault();
        setSlashMenuOpen(false);
        return;
      }
      // Input history navigation (fish-style: prefix-match on buffer, with
      // a friendly fallback to "show the newest entry" when the buffer does
      // not match any history prefix). Skipped entirely when IME composition
      // is active so the user can still use the arrow keys to pick a CJK
      // candidate. If userMessageHistory is empty, we fall through to the
      // default textarea behaviour (caret moves up/down).
      const history = userMessageHistory ?? [];
      if (!e.nativeEvent.isComposing && history.length > 0) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          if (historyIndex === null) {
            const buffer = value;
            const needle = buffer.toLowerCase();
            const subset = buffer
              ? history.filter((h) => h.toLowerCase().startsWith(needle))
              : history;
            const pool = subset.length > 0 ? subset : history;
            setDraftBeforeHistory(value);
            setHistoryIndex(0);
            fillFromHistory(pool[pool.length - 1]);
          } else {
            const next = Math.min(historyIndex + 1, history.length - 1);
            if (next !== historyIndex) {
              setHistoryIndex(next);
              fillFromHistory(history[history.length - 1 - next]);
            }
          }
          return;
        }
        if (e.key === "ArrowDown") {
          if (historyIndex === null) return; // not browsing history → caret moves
          e.preventDefault();
          const next = historyIndex - 1;
          if (next < 0) {
            // Past the newest entry → restore the pre-history draft (E1).
            const draft = draftBeforeHistory;
            setHistoryIndex(null);
            setDraftBeforeHistory("");
            fillFromHistory(draft);
          } else {
            setHistoryIndex(next);
            fillFromHistory(history[history.length - 1 - next]);
          }
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        // /new as a bare message triggers the action directly
        if (value.trim() === "/new") {
          onSlashAction?.("new");
          setValue("");
          setCursorPosition(0);
          setSelectedSlashResource(null);
          setSlashMenuOpen(false);
          if (textareaRef.current) textareaRef.current.style.height = "auto";
          return;
        }
        // While the agent is running there is nothing to send to — handleSend
        // no-ops on isStreaming, so Enter just leaves the draft in place.
        handleSend();
      }
    },
    [handleSend, slashMenuOpen, slashQuery, visibleSlashResources, slashActiveIndex, slashPageCount, selectSlashResource, selectedSlashResource, value, onSlashAction, userMessageHistory, historyIndex, draftBeforeHistory, fillFromHistory]
  );

  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (!imageItems.length) return;
    e.preventDefault();
    const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
    processImageFiles(files);
  }, [processImageFiles]);



  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name }));
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    }));
  })();

  // Group options by provider, preserving insertion order
  const modelsByProvider: { provider: string; options: ModelOption[] }[] = [];
  for (const opt of modelOptions) {
    const group = modelsByProvider.find((g) => g.provider === opt.provider);
    if (group) group.options.push(opt);
    else modelsByProvider.push({ provider: opt.provider, options: [opt] });
  }

  const currentName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name ?? model.modelId)
    : modelOptions.length > 0 ? modelOptions[0].name : null;

  const thinkingLevelDesc: Record<typeof THINKING_LEVELS[number], string> = {
    auto: t("Use pi default"),
    off: t("Disable reasoning"),
    minimal: t("Minimal reasoning"),
    low: t("Low reasoning"),
    medium: t("Medium reasoning"),
    high: t("High reasoning"),
    xhigh: t("Highest reasoning"),
  };

  // Context usage cells — 10 discrete bars, each covering a 10% bucket. Color
  // thresholds mirror the top-right status bar (>70% yellow, >90% red).
  const contextBar = useMemo(() => {
    if (!contextUsage?.contextWindow || contextUsage.percent === null) return null;
    const pct = Math.max(0, Math.min(100, contextUsage.percent));
    const color = pct > 90 ? "#ef4444" : pct > 70 ? "rgba(234,179,8,0.95)" : "var(--accent)";
    const ctxWindowFmt = contextUsage.contextWindow >= 1_000_000
      ? `${(contextUsage.contextWindow / 1_000_000).toFixed(1)}M`
      : contextUsage.contextWindow >= 1000
        ? `${(contextUsage.contextWindow / 1000).toFixed(0)}k`
        : String(contextUsage.contextWindow);
    // 0% → 0 cells lit; 0.1–10% → 1; 10.1–20% → 2; …; 99.1–100% → 10.
    const filledCells = Math.min(10, Math.ceil(pct / 10));
    return { pct, color, ctxWindowFmt, filledCells };
  }, [contextUsage]);

  // Auto-name is only available when there's a session, a usable first user
  // message, the agent isn't streaming, and no LLM call is already in flight.
  const canAutoName = Boolean(
    sessionId &&
    firstUserMessageText &&
    firstUserMessageText.trim() &&
    !isStreaming &&
    !isAutoNaming
  );

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        modelDropdownPanelRef.current && !modelDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
      if (toolDropdownRef.current && !toolDropdownRef.current.contains(e.target as Node)) {
        setToolDropdownOpen(false);
      }
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(e.target as Node)) {
        setThinkingDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);



  return (
    <div
      style={{
        flexShrink: 0,
        background: "transparent",
        padding: "0 16px 8px",
      }}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processImageFiles(files);
          e.target.value = "";
        }}
      />
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        {/* Retry banner */}
        {retryInfo && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.25)",
            borderRadius: 6, fontSize: 12, color: "rgba(180,130,0,0.9)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            {t("Retrying")} ({retryInfo.attempt}/{retryInfo.maxAttempts})…{retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {/* Image previews */}
        {attachedImages.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedImages.map((img, i) => (
              <div key={i} style={{ position: "relative", flexShrink: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.previewUrl}
                  alt=""
                  style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                />
                <button
                  onClick={() => removeImage(i)}
                  style={{
                    position: "absolute", top: -4, right: -4,
                    width: 16, height: 16, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {selectedPromptResource && selectedPromptPreview !== null && (
          <div style={{
            height: 156,
            marginBottom: 8,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}>
            <div style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 10px",
              borderBottom: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              color: "var(--text-muted)",
              fontSize: 12,
            }}>
              <span style={{ color: "var(--accent)", fontWeight: 700, textTransform: "uppercase", fontSize: 10 }}>
                prompt
              </span>
              <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                /{selectedPromptResource.command}
              </span>
            </div>
            <pre style={{
              margin: 0,
              padding: "9px 10px",
              flex: 1,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "var(--text)",
              fontSize: 12,
              lineHeight: 1.5,
              fontFamily: "var(--font-mono)",
            }}>
              {selectedPromptPreview}
            </pre>
          </div>
        )}

        {/* Main input */}
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            background: "var(--bg)",
            border: `1px solid ${isStreaming ? "color-mix(in srgb, var(--border) 70%, transparent)" : (THINKING_BORDER_COLOR[thinkingLevel ?? "auto"])}`,
            borderRadius: 14,
            padding: "10px 10px 10px 14px",
            boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
            transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
            position: "relative",
          } as React.CSSProperties}
        >
          {!value && !isFocused && !isStreaming && (
            <span
              aria-hidden
              style={{
                position: "absolute",
                top: "50%",
                left: 14,
                transform: "translateY(-50%)",
                pointerEvents: "none",
                color: "var(--text-muted)",
                fontSize: 14,
                lineHeight: 1.6,
                fontWeight: 400,
              }}
            >
              <Typewriter phrases={TYPEWRITER_PHRASES[locale]} />
            </span>
          )}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setCursorPosition(e.target.selectionStart ?? e.target.value.length);
              setSlashMenuOpen(Boolean(getSlashQuery(e.target.value, e.target.selectionStart ?? e.target.value.length)));
              // E2: any user edit exits the history index so the next
              // ArrowUp is treated as a fresh recall, not a continuation.
              if (historyIndex !== null) {
                setHistoryIndex(null);
                setDraftBeforeHistory("");
              }
            }}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onPaste={handlePaste}
            onSelect={(e) => {
              const pos = e.currentTarget.selectionStart ?? value.length;
              setCursorPosition(pos);
              setSlashMenuOpen(Boolean(getSlashQuery(value, pos)));
            }}
            onFocus={(e) => {
              const pos = e.currentTarget.selectionStart ?? value.length;
              setCursorPosition(pos);
              setSlashMenuOpen(Boolean(getSlashQuery(value, pos)));
              setIsFocused(true);
            }}
            onBlur={() => setIsFocused(false)}
            placeholder={
              isFocused
                ? ""
                : isStreaming
                  ? t("Agent is running...")
                  : !value
                    ? ""
                    : t("Message...")
            }
            rows={1}
            style={{
              flex: 1,
              background: "none",
              border: "none",
              outline: "none",
              resize: "none",
              color: "var(--text)",
              fontSize: 14,
              lineHeight: 1.6,
              fontFamily: "inherit",
              minHeight: 24,
              maxHeight: 200,
              overflow: "auto",
            }}
            data-hide-v-scrollbar
          />

          {!isStreaming && (
            <button
              onClick={handleSend}
              disabled={!value.trim() && !attachedImages.length && !selectedSlashResource}
              aria-label={t("Send")}
              style={{
                flexShrink: 0,
                alignSelf: "flex-end",
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 34, height: 34, padding: 0,
                background: (value.trim() || attachedImages.length || selectedSlashResource) ? "var(--accent)" : "var(--bg-panel)",
                border: "none",
                borderRadius: "50%",
                color: (value.trim() || attachedImages.length || selectedSlashResource) ? "#fff" : "var(--text-dim)",
                cursor: (value.trim() || attachedImages.length || selectedSlashResource) ? "pointer" : "not-allowed",
                boxShadow: (value.trim() || attachedImages.length || selectedSlashResource) ? "0 1px 3px rgba(37,99,235,0.25)" : "none",
                transition: "background 0.15s, box-shadow 0.15s",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="13" x2="8" y2="4" />
                <polyline points="4 7.5 8 3.5 12 7.5" />
              </svg>
            </button>
          )}
        </div>
        {(selectedSlashResource || (slashMenuOpen && slashQuery)) && (
          <div style={{ position: "relative" }}>
            {selectedSlashResource && (
              <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  maxWidth: "100%", padding: "4px 8px",
                  background: "var(--bg-panel)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)", fontSize: 12,
                }}>
                  <span style={{
                    color: selectedSlashResource.source === "skill" ? "#059669" : "var(--accent)",
                    fontWeight: 700, textTransform: "uppercase", fontSize: 10,
                  }}>
                    {selectedSlashResource.source}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    /{selectedSlashResource.command}
                  </span>
                  <Tooltip content={t("Remove")}>
                  <button
                    onClick={() => setSelectedSlashResource(null)}
                    style={{
                      width: 16, height: 16, border: "none", background: "none",
                      color: "var(--text-dim)", cursor: "pointer", padding: 0,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <line x1="1.5" y1="1.5" x2="7.5" y2="7.5" /><line x1="7.5" y1="1.5" x2="1.5" y2="7.5" />
                    </svg>
                  </button>
                  </Tooltip>
                </span>
              </div>
            )}
            {slashMenuOpen && slashQuery && (
              <div style={{
                position: "absolute", bottom: "calc(100% + 44px)", left: 0,
                zIndex: 200, width: "min(560px, 100%)",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                overflow: "hidden",
              }}>
                {visibleSlashResources.length > 0 ? (
                  <>
                    {visibleSlashResources.map((item, index) => {
                      const active = index === slashActiveIndex;
                      return (
                        <button
                          key={`${item.source}:${item.path}`}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectSlashResource(item);
                          }}
                          style={{
                            width: "100%", display: "grid", gridTemplateColumns: "72px minmax(0, 1fr)",
                            gap: 10, padding: "8px 10px",
                            background: active ? "var(--bg-selected)" : "none",
                            border: "none", borderBottom: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
                            color: active ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", textAlign: "left",
                          }}
                        >
                          <span style={{
                            alignSelf: "start", justifySelf: "start",
                            padding: "2px 6px", borderRadius: 5,
                            background: item.source === "skill" ? "rgba(5,150,105,0.10)" : item.source === "action" ? "rgba(234,179,8,0.10)" : "rgba(37,99,235,0.10)",
                            color: item.source === "skill" ? "#059669" : item.source === "action" ? "rgba(180,130,0,0.9)" : "var(--accent)",
                            fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                          }}>
                            {item.source}
                          </span>
                          <span style={{ minWidth: 0 }}>
                            <span style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                /{item.command}
                              </span>
                              {item.argumentHint && (
                                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                                  {item.argumentHint}
                                </span>
                              )}
                            </span>
                            {item.description && (
                              <span style={{ display: "block", marginTop: 2, fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {item.description}
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                    <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-dim)", textAlign: "right" }}>
                      {t("↑↓ switch, ←→ page")}
                    </div>
                  </>
                ) : (
                  <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--text-dim)" }}>
                    {t("No matches")}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Bottom bar: left | center (context) | right */}
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>

          {/* LEFT: attach + model selector */}
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 2 }}>
            <IconHoverButton
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming}
              icon={
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
              }
              label={t("Attach")}
              title={t("Attach image")}
              ariaLabel={t("Attach image")}
              variant={attachedImages.length ? "accent" : "default"}
            />
            {/* Model selector — visible always, disabled during streaming */}
            {modelOptions.length > 0 && currentName && onModelChange && (
                <div ref={dropdownRef} style={{ position: "relative" }}>
                  <button
                    onClick={(e) => {
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setModelDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                      setModelDropdownOpen((v) => !v);
                    }}
                    disabled={isStreaming}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "8px 12px",
                      height: 32,
                      maxWidth: 220, overflow: "hidden",
                      background: modelDropdownOpen ? "var(--bg-hover)" : "none",
                      border: "none",
                      borderRadius: 9,
                      color: "var(--text-muted)",
                      cursor: isStreaming ? "not-allowed" : "pointer",
                      fontSize: 12,
                      opacity: isStreaming ? 0.5 : 1,
                      transition: "background 0.12s, color 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      if (isStreaming) return;
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.color = "var(--text)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = modelDropdownOpen ? "var(--bg-hover)" : "none";
                      e.currentTarget.style.color = "var(--text-muted)";
                    }}
                  >
                    <ProviderIcon
                      id={model?.provider ?? ""}
                      size={12}
                      fallback={
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="4" y="4" width="16" height="16" rx="2" />
                          <rect x="9" y="9" width="6" height="6" />
                          <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                          <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                          <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                          <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                        </svg>
                      }
                    />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{currentName}</span>
                  </button>
                  {modelDropdownOpen && modelDropdownRect && (() => {
                    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                    const bottom = viewportHeight - modelDropdownRect.top + 6;
                    const maxH = Math.max(120, Math.min(modelDropdownRect.top - 8, viewportHeight * 0.6));
                    return (
                    <div ref={modelDropdownPanelRef} style={{
                      position: "fixed",
                      bottom, left: modelDropdownRect.left,
                      zIndex: 500, background: "var(--bg)", border: "1px solid var(--border)",
                      borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                      overflow: "hidden", width: "max-content", minWidth: modelDropdownRect.width, maxHeight: maxH, overflowY: "auto",
                    }}>
                      {modelsByProvider.map((group, gi) => (
                        <div key={group.provider}>
                          {(modelsByProvider.length > 1) && (
                            <div style={{
                              padding: "6px 12px 4px",
                              fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                              textTransform: "uppercase", letterSpacing: "0.07em",
                              borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                            }}>
                              {group.provider}
                            </div>
                          )}
                          {group.options.map((opt) => {
                            const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                            return (
                              <button
                                key={`${opt.provider}:${opt.modelId}`}
                                onClick={() => { setModelDropdownOpen(false); if (!isActive) onModelChange(opt.provider, opt.modelId); }}
                                style={{
                                  display: "flex", alignItems: "center", gap: 8,
                                  width: "100%", padding: "7px 12px",
                                  background: isActive ? "var(--bg-selected)" : "none",
                                  border: "none",
                                  color: isActive ? "var(--text)" : "var(--text-muted)",
                                  cursor: "pointer", fontSize: 12, textAlign: "left",
                                  fontWeight: isActive ? 600 : 400,
                                  whiteSpace: "nowrap",
                                }}
                                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                              >
                                {isActive
                                  ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                                  : <span style={{ width: 10, flexShrink: 0 }} />}
                                {opt.name}
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                    );
                  })()}
                </div>
            )}
          </div>

          {/* CENTER: context usage cells — sits next to the model selector */}
          {contextBar && (
            <Tooltip content={`${t("Context")}: ${contextBar.pct.toFixed(1)}% of ${contextUsage!.contextWindow.toLocaleString()} tokens`}>
              <div
                aria-label={`${t("Context")}: ${contextBar.pct.toFixed(0)}%`}
                style={{
                  flex: "0 0 auto",
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "0 10px",
                  height: 32,
                  color: contextBar.color,
                  fontSize: 12,
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                }}
              >
                <div
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={contextBar.pct}
                  style={{
                    display: "flex",
                    gap: 2,
                    width: 65, height: 8,
                    flexShrink: 0,
                  }}
                >
                  {Array.from({ length: 10 }, (_, i) => {
                    const active = i < contextBar.filledCells;
                    return (
                      <div
                        key={i}
                        style={{
                          flex: 1,
                          height: "100%",
                          background: active ? contextBar.color : "color-mix(in srgb, var(--text-muted) 20%, var(--bg-panel))",
                          borderRadius: 1,
                          transition: "background 0.2s ease",
                        }}
                      />
                    );
                  })}
                </div>
                <span style={{ fontWeight: 600 }}>{contextBar.pct.toFixed(0)}%</span>
                <span style={{ color: "var(--text-dim)", fontSize: 11 }}>/ {contextBar.ctxWindowFmt}</span>
              </div>
            </Tooltip>
          )}

          {/* spacer */}
          <div style={{ flex: 1 }} />

          {/* RIGHT: thinking + tools preset + compact (idle) | Stop (streaming) */}
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 2, marginLeft: "auto" }}>
            {onOpenReplay && replayAvailable && (
              <IconHoverButton
                onClick={onOpenReplay}
                icon={
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" />
                  </svg>
                }
                label={t("Replay")}
                title={t("Replay")}
              />
            )}

            {!isStreaming && onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative" }}>
                <IconHoverButton
                  onClick={() => setThinkingDropdownOpen((v) => !v)}
                  active={thinkingDropdownOpen}
                  icon={
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                      <line x1="7" y1="18" x2="12" y2="18" />
                      <line x1="8" y1="21" x2="11" y2="21" />
                    </svg>
                  }
                  label={t("Thinking")}
                  title={t("Change thinking level")}
                />
                {thinkingDropdownOpen && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", minWidth: 180,
                  }}>
                    {THINKING_LEVELS.filter((lvl) => {
                      if (!availableThinkingLevels) return true;
                      if (lvl === "auto") return true;
                      return availableThinkingLevels.includes(lvl);
                    }).map((lvl) => {
                      const isActive = (thinkingLevel ?? "auto") === lvl;
                      const desc = thinkingLevelDesc[lvl];
                      const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                      const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                      const showOriginal = mappedVal != null && mappedVal !== lvl;
                      return (
                        <button
                          key={lvl}
                          onClick={() => { setThinkingDropdownOpen(false); if (!isActive) onThinkingLevelChange(lvl); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "none",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>
                            {displayLabel}
                            {showOriginal && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 5 }}>({lvl})</span>}
                          </span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {!isStreaming && onToolPresetChange && (
              <div ref={toolDropdownRef} style={{ position: "relative" }}>
                <IconHoverButton
                  onClick={() => setToolDropdownOpen((v) => !v)}
                  active={toolDropdownOpen}
                  icon={
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                    </svg>
                  }
                  label={t("Tools")}
                  title={t("Change tool preset")}
                />
                {toolDropdownOpen && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", minWidth: 120,
                  }}>
                    {TOOL_PRESETS.map((lvl) => {
                      const preset = TOOL_PRESET_MAP[lvl];
                      const isActive = toolPreset === preset;
                      const desc = lvl === "off" ? t("No tools, chat only") : t("All available tools");
                      return (
                        <button
                          key={lvl}
                          onClick={() => { setToolDropdownOpen(false); if (!isActive) onToolPresetChange(preset); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "none",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>{lvl}</span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {!isStreaming && onCompact && (
              <div style={{ position: "relative" }}>
                {compactError && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                    background: "#1f2937", color: "#f87171",
                    fontSize: 11, padding: "4px 8px", borderRadius: 5,
                    whiteSpace: "nowrap", pointerEvents: "none",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.2)", zIndex: 50,
                  }}>
                    {compactError}
                  </div>
                )}
                <IconHoverButton
                  onClick={isCompacting ? onAbortCompaction! : onCompact!}
                  disabled={isStreaming && !isCompacting}
                  variant={isCompacting ? "danger" : "default"}
                  label={isCompacting ? t("Stop") : t("Compact")}
                  title={isCompacting ? t("Stop compaction") : t("Compact context")}
                  icon={isCompacting ? (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" /></svg>
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
                      <line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" />
                    </svg>
                  )}
                />
              </div>
            )}

            {onExport && sessionId && (
              <div style={{ position: "relative" }}>
                <IconHoverButton
                  onClick={onExport!}
                  disabled={isStreaming && !isExporting}
                  variant={isExporting ? "accent" : "default"}
                  expandDirection="left"
                  label={isExporting ? t("Exporting...") : t("Export")}
                  title={isExporting ? t("Exporting...") : t("Export session")}
                  ariaLabel={isExporting ? t("Exporting...") : t("Export session")}
                  icon={isExporting ? (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="2" x2="12" y2="6" />
                      <line x1="12" y1="16" x2="12" y2="22" />
                      <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
                      <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
                      <line x1="2" y1="12" x2="6" y2="12" />
                      <line x1="16" y1="12" x2="22" y2="12" />
                    </svg>
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  )}
                />
              </div>
            )}

            {sessionId && (
              <IconHoverButton
                onClick={handleAutoName}
                disabled={!canAutoName}
                variant={isAutoNaming ? "accent" : "default"}
                expandDirection="left"
                label={
                  autoNamedDisplay
                    ? autoNamedDisplay
                    : isAutoNaming
                      ? t("Naming...")
                      : t("Auto-name")
                }
                title={
                  isAutoNaming
                    ? t("Naming...")
                    : t("Auto-name session")
                }
                ariaLabel={
                  isAutoNaming
                    ? t("Naming...")
                    : t("Auto-name session")
                }
                icon={isAutoNaming ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2l1.8 5.4L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.6L12 2z" />
                    <path d="M19 14l.9 2.6L22 17.5l-2.1.9L19 21l-.9-2.6L16 17.5l2.1-.9L19 14z" />
                  </svg>
                )}
              />
            )}

            {onNewSession && (
              <IconHoverButton
                onClick={onNewSession}
                variant="accent"
                expandDirection="left"
                label={t("New")}
                title={t("New session")}
                ariaLabel={t("New session")}
                icon={
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="6" y1="1.5" x2="6" y2="10.5" />
                    <line x1="1.5" y1="6" x2="10.5" y2="6" />
                  </svg>
                }
              />
            )}

            {isStreaming && (
              <button
                onClick={onAbort}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "8px 14px",
                  height: 32,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: 9,
                  color: "#ef4444",
                  cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                  whiteSpace: "nowrap", letterSpacing: "-0.01em",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.16)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
                {t("Stop")}
              </button>
            )}
          </div>

        </div>
      </div>
    </div>
  );
});
