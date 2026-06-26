"use client";

import { useSyncExternalStore } from "react";
import { isContentEqual } from "@/lib/shallowEqual";

/**
 * Module store for the HTTP debug panel (right-panel tab).
 *
 * Mirrors the sessionUiStore/toolCallStatsStore pattern: a single typed state
 * object, useSyncExternalStore-based subscription, content-equality guarded
 * patcher. The HttpPanel component reads + writes through this store so the
 * in-progress form survives tab switches and panel closes (no disk
 * persistence, by design — see plan).
 *
 * URL ↔ Params bidirectional sync uses the `lastEdited` discriminator field
 * to break the loop: whichever side the user touched most recently owns the
 * next sync, and the other side is not disturbed until the user types in it.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
export type BodyMode = "none" | "json" | "raw";
export type KvTarget = "params" | "headers";

export interface KVRow {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface HttpDraft {
  method: HttpMethod;
  url: string;
  params: KVRow[];
  headers: KVRow[];
  bodyMode: BodyMode;
  body: string;
  options: { timeoutMs: number };
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: "text" | "base64";
  durationMs: number;
  size: number;
  contentType: string;
}

export type HttpErrorKind =
  | "timeout"
  | "aborted"
  | "fetch_failed"
  | "body_too_large"
  | "invalid_url"
  | "invalid_json"
  | "network";

export interface HttpError {
  kind: HttpErrorKind;
  message: string;
}

export interface HttpState {
  draft: HttpDraft;
  lastResponse: HttpResponse | null;
  lastAttempt: HttpDraft | null;
  inFlight: { id: string; startedAt: number } | null;
  error: HttpError | null;
  lastEdited: "url" | "params";
}

let kvIdCounter = 0;
export function newKvId(): string {
  kvIdCounter += 1;
  return `kv-${kvIdCounter}-${Date.now().toString(36)}`;
}

function emptyKvRow(): KVRow {
  return { id: newKvId(), key: "", value: "", enabled: true };
}

const INITIAL_DRAFT: HttpDraft = {
  method: "GET",
  url: "",
  params: [],
  headers: [],
  bodyMode: "none",
  body: "",
  options: { timeoutMs: 30_000 },
};

const INITIAL: HttpState = {
  draft: INITIAL_DRAFT,
  lastResponse: null,
  lastAttempt: null,
  inFlight: null,
  error: null,
  lastEdited: "url",
};

let state: HttpState = INITIAL;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function setHttpState(patch: Partial<HttpState>) {
  let changed = false;
  for (const k in patch) {
    const next = patch[k as keyof HttpState];
    const cur = state[k as keyof HttpState];
    if (!isContentEqual(next, cur)) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...patch };
  emit();
}

export function resetHttpState() {
  state = INITIAL;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): HttpState {
  return state;
}

function getServerSnapshot(): HttpState {
  return INITIAL;
}

export function useHttpState(): HttpState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ── Action helpers ───────────────────────────────────────────────────────
// Each helper performs a read-mutate-write on the module state. They are
// intentionally not hooks so the panel can call them from event handlers
// without re-render thrash.

export function setHttpDraft(patch: Partial<HttpDraft>) {
  setHttpState({ draft: { ...state.draft, ...patch } });
}

export function setHttpMethod(method: HttpMethod) {
  setHttpDraft({ method });
}

export function setHttpUrl(url: string, opts?: { syncParams?: boolean }) {
  setHttpState({
    draft: { ...state.draft, url },
    lastEdited: "url",
  });
  if (opts?.syncParams === false) return;
  // Sync params FROM the URL, unless the URL is malformed (empty / partial).
  if (!safeUrl(url)) return;
  const nextParams = syncParamsFromUrl(url);
  setHttpParams(nextParams, { syncUrl: false });
}

export function setHttpParams(params: KVRow[], opts?: { syncUrl?: boolean }) {
  setHttpState({
    draft: { ...state.draft, params },
    lastEdited: "params",
  });
  if (opts?.syncUrl === false) return;
  // Sync url FROM params only if the current URL is a valid base.
  if (!safeUrl(state.draft.url)) return;
  const nextUrl = syncUrlFromParams(state.draft.url, params);
  setHttpUrl(nextUrl, { syncParams: false });
}

function safeUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

export function setHttpHeaders(headers: KVRow[]) {
  setHttpDraft({ headers });
}

export function setHttpBodyMode(bodyMode: BodyMode) {
  setHttpDraft({ bodyMode });
}

export function setHttpBody(body: string) {
  setHttpDraft({ body });
}

export function setHttpTimeoutMs(timeoutMs: number) {
  setHttpDraft({ options: { ...state.draft.options, timeoutMs } });
}

export function addKvRow(target: KvTarget) {
  const next = [...state.draft[target], emptyKvRow()];
  if (target === "params") setHttpParams(next);
  else setHttpHeaders(next);
}

export function removeKvRow(target: KvTarget, id: string) {
  const next = state.draft[target].filter((r) => r.id !== id);
  if (target === "params") setHttpParams(next);
  else setHttpHeaders(next);
}

export function updateKvRow(target: KvTarget, id: string, patch: Partial<KVRow>) {
  const next = state.draft[target].map((r) => (r.id === id ? { ...r, ...patch } : r));
  if (target === "params") setHttpParams(next);
  else setHttpHeaders(next);
}

export function setHttpInFlight(handle: HttpState["inFlight"]) {
  setHttpState({ inFlight: handle });
}

export function setHttpLastResponse(resp: HttpResponse | null) {
  setHttpState({ lastResponse: resp });
}

export function setHttpLastAttempt(attempt: HttpDraft | null) {
  setHttpState({ lastAttempt: attempt });
}

export function setHttpError(err: HttpError | null) {
  setHttpState({ error: err });
}

export function clearHttpPanel() {
  setHttpState({
    draft: INITIAL_DRAFT,
    lastResponse: null,
    lastAttempt: null,
    error: null,
    // Keep inFlight alone — caller is responsible for cancelling first.
    lastEdited: "url",
  });
}

// ── Pure helpers exported for the panel to call ──────────────────────────
//
// syncParamsFromUrl parses the query string of `url` and returns the
// corresponding KVRow[]. The caller is responsible for writing the result
// back to the store via setHttpParams(...) and respecting lastEdited to
// avoid ping-pong.

export function syncParamsFromUrl(url: string): KVRow[] {
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return state.draft.params;
  const qs = url.slice(qIdx + 1);
  if (!qs) return [];
  const rows: KVRow[] = [];
  for (const pair of qs.split("&")) {
    if (!pair) continue;
    const eqIdx = pair.indexOf("=");
    const rawKey = eqIdx === -1 ? pair : pair.slice(0, eqIdx);
    const rawVal = eqIdx === -1 ? "" : pair.slice(eqIdx + 1);
    let key = "";
    let value = "";
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, " "));
      value = decodeURIComponent(rawVal.replace(/\+/g, " "));
    } catch {
      key = rawKey;
      value = rawVal;
    }
    rows.push({ id: newKvId(), key, value, enabled: true });
  }
  return rows;
}

export function syncUrlFromParams(currentUrl: string, params: KVRow[]): string {
  const base = currentUrl.split("?")[0];
  const enabled = params.filter((p) => p.enabled && p.key);
  if (enabled.length === 0) return base;
  const qs = enabled
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join("&");
  return `${base}?${qs}`;
}

export function kvRowsToObject(rows: KVRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (!r.enabled || !r.key) continue;
    out[r.key] = r.value;
  }
  return out;
}

export function buildFinalUrl(draft: HttpDraft): string {
  return syncUrlFromParams(draft.url, draft.params);
}

export function deriveContentType(headers: Record<string, string>): string {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "content-type") return headers[k];
  }
  return "";
}