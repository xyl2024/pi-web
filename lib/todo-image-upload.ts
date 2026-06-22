"use client";

/**
 * Upload todo-related image files to the server and return their absolute URLs.
 * Used by both the Tiptap rich-text editor (paste / drop / insert) and any
 * future image-aware editor. Errors are returned alongside the URLs so the
 * caller can surface them as toasts without aborting the whole batch.
 *
 * The upload endpoint is `POST /api/todo-images` (see app/api/todo-images/route.ts).
 * Each file is sent as multipart/form-data under the "file" field.
 */
export async function uploadTodoImages(
  files: File[],
): Promise<{ urls: string[]; errors: string[] }> {
  if (files.length === 0) return { urls: [], errors: [] };
  const results = await Promise.all(
    files.map(async (file, idx): Promise<{ url?: string; error?: string }> => {
      try {
        const fd = new FormData();
        fd.append("file", file, file.name || `pasted-${idx + 1}.png`);
        const res = await fetch("/api/todo-images", { method: "POST", body: fd });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { url: string };
        return { url: data.url };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  const urls: string[] = [];
  const errors: string[] = [];
  for (const r of results) {
    if (r.url) urls.push(r.url);
    else if (r.error) errors.push(r.error);
  }
  return { urls, errors };
}

/**
 * Pull every File out of a DragEvent / ClipboardEvent dataTransfer. Filters
 * down to image/* MIME types so non-image drags fall through to Tiptap's
 * default insertion logic.
 */
export function extractImageFiles(dataTransfer: DataTransfer | null | undefined): File[] {
  if (!dataTransfer) return [];
  const out: File[] = [];
  const files = dataTransfer.files;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f && f.type.startsWith("image/")) out.push(f);
  }
  return out;
}

/**
 * Pull every File out of a ClipboardEvent's clipboardData that has an image/*
 * MIME type. Paste events split items across types so we walk `items`, not
 * `files`.
 */
export function extractClipboardImageFiles(event: ClipboardEvent): File[] {
  const items = event.clipboardData?.items;
  if (!items) return [];
  const out: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}
