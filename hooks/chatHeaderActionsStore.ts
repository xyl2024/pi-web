"use client";

import { useSyncExternalStore } from "react";
import { isContentEqual } from "@/lib/shallowEqual";

/**
 * Session-scoped header actions: the Replay / Export / Auto-name buttons
 * rendered in the AppShell top bar but owned by ChatWindowContent. Same
 * pattern as sessionUiStore — ChatWindowContent publishes on every render
 * (content-guarded so identical snapshots don't re-render AppShell), clears
 * on unmount, AppShell reads via useChatHeaderActions().
 *
 * Handlers live in the snapshot because they are stable useCallbacks; the
 * content guard compares them by reference (isContentEqual falls back to
 * `a === b` for functions), so a rebuild only re-publishes when a scalar
 * field changed alongside it.
 */

export interface ChatHeaderActions {
  onOpenReplay: () => void;
  /** Non-streaming + has messages — same gate as the old bottom-bar button. */
  replayVisible: boolean;
  onExport: () => void;
  /** Session selected + agent not running — same gate as the old button. */
  exportVisible: boolean;
  isExporting: boolean;
  onAutoName: () => void;
  /** Session selected + agent not running — same gate as the old button. */
  autoNameVisible: boolean;
  /** Session + usable first user message + idle — false renders the button disabled. */
  canAutoName: boolean;
  isAutoNaming: boolean;
}

let state: ChatHeaderActions | null = null;
const listeners = new Set<() => void>();

export function setChatHeaderActions(next: ChatHeaderActions | null) {
  if (isContentEqual(next, state)) return;
  state = next;
  for (const l of listeners) l();
}

export function useChatHeaderActions(): ChatHeaderActions | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => state,
    () => null,
  );
}
