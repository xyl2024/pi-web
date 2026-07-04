"use client";

/**
 * Upload note-related image files to the server and return their absolute URLs.
 * Used by the Tiptap rich-text editor (paste / drop / insert) when editing
 * notes. Errors are returned alongside the URLs so the caller can surface
 * them as toasts without aborting the whole batch.
 *
 * The upload endpoint is `POST /api/note-images` (see app/api/note-images/route.ts).
 * Each file is sent as multipart/form-data under the "file" field.
 */
export async function uploadNoteImages(
  files: File[],
): Promise<{ urls: string[]; errors: string[] }> {
  if (files.length === 0) return { urls: [], errors: [] };
  const results = await Promise.all(
    files.map(async (file, idx): Promise<{ url?: string; error?: string }> => {
      try {
        const fd = new FormData();
        fd.append("file", file, file.name || `pasted-${idx + 1}.png`);
        const res = await fetch("/api/note-images", { method: "POST", body: fd });
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