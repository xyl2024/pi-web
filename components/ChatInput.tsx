"use client";

import React, { useRef, useState, useCallback, useEffect, useImperativeHandle, forwardRef, KeyboardEvent, useMemo } from "react";
import { useI18n } from "@/hooks/useI18n";
import { Tooltip } from "./Tooltip";

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
  source: "prompt" | "skill";
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
  onSteer?: (message: string, images?: AttachedImage[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => void;
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
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  slashResources?: SlashResource[];
  slashResourceKey?: string;
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
const SLASH_PAGE_SIZE = 5;

function getSlashQuery(value: string, cursor: number): { start: number; query: string } | null {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s)\/([^\s/]*)$/);
  if (!match) return null;
  return {
    start: beforeCursor.length - match[2].length - 1,
    query: match[2],
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
  const path = item.path.replace(/"/g, "&quot;");
  const skillBlock = `<skill name="${name}" location="${path}">\n${content}\n</skill>`;
  const args = argsString.trim();
  return args ? `${skillBlock}\n\n${args}` : skillBlock;
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
  onSend, onAbort, onSteer, onFollowUp, isStreaming, model, modelNames, modelList, onModelChange,
  onCompact, onAbortCompaction, isCompacting, compactError, toolPreset, onToolPresetChange,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo,
  soundEnabled, onSoundToggle,
  slashResources = [], slashResourceKey,
}: Props, ref) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [cursorPosition, setCursorPosition] = useState(0);
  const [selectedSlashResource, setSelectedSlashResource] = useState<SlashResource | null>(null);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashPage, setSlashPage] = useState(0);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const toolDropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const slashQuery = useMemo(() => getSlashQuery(value, cursorPosition), [value, cursorPosition]);
  const filteredSlashResources = useMemo(() => {
    if (!slashMenuOpen || !slashQuery) return [];
    const q = slashQuery.query.toLowerCase();
    return slashResources.filter((item) => {
      return item.command.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q);
    });
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
    setValue("");
    setCursorPosition(0);
    setSelectedSlashResource(null);
    setSlashMenuOpen(false);
    clearImages();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, attachedImages, isStreaming, onSend, clearImages, buildMessage]);

  const sendQueued = useCallback((mode: "steer" | "followup") => {
    const msg = buildMessage(value);
    if (!msg && !attachedImages.length) return;
    if (mode === "steer" && onSteer) {
      onSteer(msg, attachedImages.length ? attachedImages : undefined);
    } else if (mode === "followup" && onFollowUp) {
      onFollowUp(msg, attachedImages.length ? attachedImages : undefined);
    }
    setValue("");
    setCursorPosition(0);
    setSelectedSlashResource(null);
    setSlashMenuOpen(false);
    clearImages();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [value, attachedImages, onSteer, onFollowUp, clearImages, buildMessage]);

  const selectSlashResource = useCallback((item: SlashResource) => {
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
  }, [cursorPosition, value]);

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
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (isStreaming && (onSteer || onFollowUp)) {
          // Default Enter sends as steer if available, else followup
          sendQueued(onSteer ? "steer" : "followup");
        } else {
          handleSend();
        }
      }
    },
    [isStreaming, onSteer, onFollowUp, sendQueued, handleSend, slashMenuOpen, slashQuery, visibleSlashResources, slashActiveIndex, slashPageCount, selectSlashResource, selectedSlashResource]
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
        paddingRight: 52, // 16px base + 36px for ChatMinimap alignment
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
            border: `1px solid ${isStreaming && (onSteer || onFollowUp)
              ? "rgba(234,179,8,0.4)"
              : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
            borderRadius: 14,
            padding: "10px 10px 10px 14px",
            boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
            transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
          } as React.CSSProperties}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setCursorPosition(e.target.selectionStart ?? e.target.value.length);
              setSlashMenuOpen(Boolean(getSlashQuery(e.target.value, e.target.selectionStart ?? e.target.value.length)));
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
            }}
            placeholder={
              isStreaming && (onSteer || onFollowUp)
                ? t("Steer immediately / queue follow-up...")
                : isStreaming ? t("Agent is running...")
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
          />

          {isStreaming ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, alignSelf: "flex-end" }}>
              {onSteer && (
                <Tooltip content={t("Interrupt the running agent and inject this message")}>
                <button
                  onClick={() => sendQueued("steer")}
                  disabled={!value.trim() && !attachedImages.length && !selectedSlashResource}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "7px 12px",
                    background: (value.trim() || attachedImages.length || selectedSlashResource) ? "rgba(234,179,8,0.12)" : "none",
                    border: "1px solid rgba(234,179,8,0.35)",
                    borderRadius: 8,
                    color: (value.trim() || attachedImages.length || selectedSlashResource) ? "rgba(180,130,0,1)" : "var(--text-dim)",
                    cursor: (value.trim() || attachedImages.length || selectedSlashResource) ? "pointer" : "not-allowed",
                    fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em",
                    transition: "background 0.12s",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 1 L9 5 L5 9" /><line x1="1" y1="5" x2="9" y2="5" />
                  </svg>
                  {t("Steer")}
                </button>
                </Tooltip>
              )}
              {onFollowUp && (
                <Tooltip content={t("Queue this message after the agent finishes")}>
                <button
                  onClick={() => sendQueued("followup")}
                  disabled={!value.trim() && !attachedImages.length && !selectedSlashResource}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "7px 12px",
                    background: (value.trim() || attachedImages.length || selectedSlashResource) ? "rgba(129,140,248,0.12)" : "none",
                    border: "1px solid rgba(129,140,248,0.35)",
                    borderRadius: 8,
                    color: (value.trim() || attachedImages.length || selectedSlashResource) ? "rgba(99,102,241,1)" : "var(--text-dim)",
                    cursor: (value.trim() || attachedImages.length || selectedSlashResource) ? "pointer" : "not-allowed",
                    fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em",
                    transition: "background 0.12s",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="1" x2="5" y2="6" /><polyline points="2.5 3.5 5 1 7.5 3.5" />
                    <line x1="2" y1="9" x2="8" y2="9" />
                  </svg>
                  {t("Follow-up")}
                </button>
                </Tooltip>
              )}
            </div>
          ) : (
            <button
              onClick={handleSend}
              disabled={!value.trim() && !attachedImages.length && !selectedSlashResource}
              style={{
                flexShrink: 0,
                alignSelf: "flex-end",
                display: "flex", alignItems: "center", gap: 6,
                padding: "7px 14px",
                background: (value.trim() || attachedImages.length || selectedSlashResource) ? "var(--accent)" : "var(--bg-panel)",
                border: "none",
                borderRadius: 8,
                color: (value.trim() || attachedImages.length || selectedSlashResource) ? "#fff" : "var(--text-dim)",
                cursor: (value.trim() || attachedImages.length || selectedSlashResource) ? "pointer" : "not-allowed",
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                boxShadow: (value.trim() || attachedImages.length || selectedSlashResource) ? "0 1px 3px rgba(37,99,235,0.25)" : "none",
                transition: "background 0.15s, box-shadow 0.15s",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="2" y1="7" x2="11" y2="7" />
                <polyline points="7.5 3 12 7 7.5 11" />
              </svg>
              {t("Send")}
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
                            background: item.source === "skill" ? "rgba(5,150,105,0.10)" : "rgba(37,99,235,0.10)",
                            color: item.source === "skill" ? "#059669" : "var(--accent)",
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

          {/* LEFT: attach + model selector (idle) or steer/followup toggle (streaming) */}
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 2 }}>
            <Tooltip content={t("Attach image")}>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming}
              style={{
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                width: 32, height: 32, padding: 0,
                background: "none", border: "none",
                borderRadius: 9,
                color: attachedImages.length ? "var(--accent)" : "var(--text-muted)",
                cursor: isStreaming ? "not-allowed" : "pointer",
                opacity: isStreaming ? 0.5 : 1,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => {
                if (isStreaming) return;
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = attachedImages.length ? "var(--accent)" : "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none";
                e.currentTarget.style.color = attachedImages.length ? "var(--accent)" : "var(--text-muted)";
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
            </Tooltip>
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
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="4" y="4" width="16" height="16" rx="2" />
                      <rect x="9" y="9" width="6" height="6" />
                      <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                      <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                      <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                      <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                    </svg>
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

          {/* spacer */}
          <div style={{ flex: 1 }} />

          {/* RIGHT: thinking + tools preset + compact + sound (idle) | Stop + sound (streaming) */}
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 2, marginLeft: "auto" }}>
            {!isStreaming && onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative" }}>
                <Tooltip content={t("Change thinking level")}>
                <button
                  onClick={() => !isStreaming && setThinkingDropdownOpen((v) => !v)}
                  disabled={isStreaming}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "8px 12px",
                    height: 32,
                    background: thinkingDropdownOpen ? "var(--bg-hover)" : "none",
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
                    e.currentTarget.style.background = thinkingDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                    <line x1="7" y1="18" x2="12" y2="18" />
                    <line x1="8" y1="21" x2="11" y2="21" />
                  </svg>
                  <span>{(() => {
                    const lvl = thinkingLevel ?? "auto";
                    if (lvl === "auto" || !thinkingLevelMap) return lvl;
                    const mapped = thinkingLevelMap[lvl];
                    return mapped != null ? mapped : lvl;
                  })()}</span>
                </button>
                </Tooltip>
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
                <Tooltip content={t("Change tool preset")}>
                <button
                  onClick={() => !isStreaming && setToolDropdownOpen((v) => !v)}
                  disabled={isStreaming}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "8px 12px",
                    height: 32,
                    background: toolDropdownOpen ? "var(--bg-hover)" : "none",
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
                    e.currentTarget.style.background = toolDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                  </svg>
                  <span>{Object.entries(TOOL_PRESET_MAP).find(([, v]) => v === toolPreset)?.[0] ?? "off"}</span>
                </button>
                </Tooltip>
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
                <button
                  onClick={isCompacting ? onAbortCompaction : onCompact}
                  disabled={isStreaming && !isCompacting}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "8px 12px",
                    height: 32,
                    background: isCompacting ? "rgba(239,68,68,0.08)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: isCompacting ? "#ef4444" : "var(--text-muted)",
                    cursor: (isStreaming && !isCompacting) ? "not-allowed" : "pointer",
                    fontSize: 12, opacity: (isStreaming && !isCompacting) ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming && !isCompacting) return;
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.16)" : "var(--bg-hover)";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.08)" : "none";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : "var(--text-muted)";
                  }}
                >
                  {isCompacting ? (
                    <><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" /></svg>{t("Compacting...")}</>
                  ) : (
                    <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
                      <line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" />
                    </svg>{t("Compact")}</>
                  )}
                </button>
              </div>
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

            {onSoundToggle !== undefined && (
              <button
                onClick={onSoundToggle}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "none",
                  border: "none",
                  borderRadius: 9,
                  color: soundEnabled ? "var(--text-muted)" : "var(--text-dim)",
                  cursor: "pointer",
                  opacity: soundEnabled ? 1 : 0.55,
                  transition: "background 0.12s, color 0.12s, opacity 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.opacity = "1";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = soundEnabled ? "var(--text-muted)" : "var(--text-dim)";
                  e.currentTarget.style.opacity = soundEnabled ? "1" : "0.55";
                }}
              >
                {soundEnabled ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                )}
              </button>
            )}
          </div>

        </div>
      </div>
    </div>
  );
});
