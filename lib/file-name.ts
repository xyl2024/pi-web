// Shared file-name validation. Imported by both the API route handlers
// (server-side authoritative check) and the FileExplorer UI (client-side
// optimistic feedback). Single source of truth for the 9-rule policy.

export type FileNameValidation =
  | { ok: true; name: string; tooLong?: boolean }
  | { ok: false; code: string; message: string };

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MAX_NAME_BYTES = 255;

export function validateFileName(raw: string): FileNameValidation {
  const name = raw.trim();
  if (!name) {
    return { ok: false, code: "empty", message: "Name cannot be empty" };
  }
  if (/[\/\\:]/.test(name)) {
    return { ok: false, code: "illegal_char", message: "Name cannot contain /, \\, or :" };
  }
  if (name.includes("\0")) {
    return { ok: false, code: "null_byte", message: "Name cannot contain null bytes" };
  }
  if (name.split("/").includes("..")) {
    return { ok: false, code: "parent_ref", message: 'Name cannot contain ".."' };
  }
  const base = name.split(".")[0] ?? "";
  if (WINDOWS_RESERVED.test(base)) {
    return { ok: false, code: "reserved", message: `"${name}" is a reserved name on Windows` };
  }
  if (Buffer.byteLength(name, "utf-8") > MAX_NAME_BYTES) {
    // Soft: warn-only on client, accepted on server.
    return { ok: true, name, tooLong: true };
  }
  return { ok: true, name };
}
