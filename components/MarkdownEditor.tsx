"use client";

// CodeMirror 6 is browser-only — load the actual implementation as a separate
// chunk so the heavy editor code only ships when a user opens a todo
// description for editing. Mirrors the Excalidraw dynamic import in
// components/FileViewer.tsx.
import type { ComponentType } from "react";
import dynamic from "next/dynamic";

export interface MarkdownEditorProps {
  defaultValue: string;
  onSave: (value: string) => void;
  onCancel: () => void;
  placeholder?: string;
  minHeight?: number;
  className?: string;
}

export const MarkdownEditor = dynamic(
  () => import("./MarkdownEditorInner").then((m) => m.MarkdownEditorInner),
  { ssr: false, loading: () => null },
) as ComponentType<MarkdownEditorProps>;
