"use client";

// Tiptap is browser-only (it touches `document` on mount). Load the actual
// implementation as a separate chunk so the editor code only ships when a
// user opens a todo description for editing. Mirrors the pattern used by
// the legacy MarkdownEditor shim.
import type { ComponentType } from "react";
import dynamic from "next/dynamic";

export type ImageUploader = (
  files: File[],
) => Promise<{ urls: string[]; errors: string[] }>;

export interface RichTextEditorProps {
  /** Initial HTML. Sanitized on save. */
  defaultValue: string;
  /** Called with the sanitized HTML when the user confirms. */
  onSave: (html: string) => void;
  /** Called when the user discards the edit. */
  onCancel: () => void;
  /** Called with the current sanitized HTML on every change. Lets the parent
   *  flush unsaved edits during page unload (pagehide + keepalive). */
  onChange?: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
  className?: string;
  /** Override the image upload endpoint. Defaults to the todo-images uploader. */
  uploadImages?: ImageUploader;
}

export const RichTextEditor = dynamic(
  () => import("./RichTextEditorInner").then((m) => m.RichTextEditorInner),
  { ssr: false, loading: () => null },
) as ComponentType<RichTextEditorProps>;
