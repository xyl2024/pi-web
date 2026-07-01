"use client";

/**
 * Client-side hook for the HTTP request Collections feature.
 *
 * Data flow (Y1/Z1): single full-snapshot GET on mount + on every window focus
 * event. After every mutation the hook refetches the entire snapshot so the
 * UI never sees stale join rows. No client-side cache, no SWR, no
 * pub/sub — the source of truth is the SQLite file and the React layer just
 * keeps a local copy of the latest server response.
 *
 * Errors are surfaced as toasts by the call sites (the hook itself just
 * returns the latest `Error` and lets the caller decide what to do). A
 * transient fetch failure does not clear the in-memory data — the drawer
 * keeps showing the last good snapshot so a network blip doesn't wipe the
 * user's view of their saved requests.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Collection,
  CreateCollectionInput,
  CreateItemInput,
  HttpItem,
  ListAllResponse,
  UpdateCollectionInput,
  UpdateItemInput,
} from "@/lib/http-collections-schema";

interface UseHttpCollectionsState {
  collections: Collection[];
  items: HttpItem[];
  joinRows: ListAllResponse["joinRows"];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  createCollection: (input: CreateCollectionInput) => Promise<Collection>;
  updateCollection: (
    id: string,
    patch: UpdateCollectionInput,
  ) => Promise<Collection>;
  deleteCollection: (
    id: string,
  ) => Promise<{ id: string; unlinkedFrom: number }>;
  createItem: (input: CreateItemInput) => Promise<HttpItem>;
  updateItem: (id: string, patch: UpdateItemInput) => Promise<HttpItem>;
  deleteItem: (
    id: string,
  ) => Promise<{ id: string; unlinkedFrom: number }>;
}

async function parseError(res: Response, fallback: string): Promise<Error> {
  let body: { error?: string } = {};
  try {
    body = (await res.json()) as { error?: string };
  } catch {
    // body wasn't JSON — use fallback
  }
  return new Error(body.error || fallback);
}

export function useHttpCollections(): UseHttpCollectionsState {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [items, setItems] = useState<HttpItem[]>([]);
  const [joinRows, setJoinRows] = useState<ListAllResponse["joinRows"]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Guard against overlapping fetches (e.g. rapid focus events).
  const inFlightRef = useRef<Promise<void> | null>(null);

  const refetch = useCallback(async () => {
    if (inFlightRef.current) return inFlightRef.current;
    const p = (async () => {
      setIsLoading(true);
      try {
        const res = await fetch("/api/http-collections", { cache: "no-store" });
        if (!res.ok) {
          throw await parseError(res, `Failed to load collections (${res.status})`);
        }
        const data = (await res.json()) as ListAllResponse;
        setCollections(data.collections);
        setItems(data.items);
        setJoinRows(data.joinRows);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        setIsLoading(false);
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = p;
    return p;
  }, []);

  // Initial fetch + window focus refetch (Y1)
  useEffect(() => {
    void refetch();
    const onFocus = () => {
      void refetch();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [refetch]);

  const createCollection = useCallback(
    async (input: CreateCollectionInput): Promise<Collection> => {
      const res = await fetch("/api/http-collections/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw await parseError(res, "Failed to save collection");
      const data = (await res.json()) as { collection: Collection };
      await refetch();
      return data.collection;
    },
    [refetch],
  );

  const updateCollection = useCallback(
    async (id: string, patch: UpdateCollectionInput): Promise<Collection> => {
      const res = await fetch(`/api/http-collections/collections/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw await parseError(res, "Failed to update collection");
      const data = (await res.json()) as { collection: Collection };
      await refetch();
      return data.collection;
    },
    [refetch],
  );

  const deleteCollection = useCallback(
    async (
      id: string,
    ): Promise<{ id: string; unlinkedFrom: number }> => {
      const res = await fetch(`/api/http-collections/collections/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw await parseError(res, "Failed to delete collection");
      const data = (await res.json()) as { ok: true; id: string; unlinkedFrom: number };
      await refetch();
      return { id: data.id, unlinkedFrom: data.unlinkedFrom };
    },
    [refetch],
  );

  const createItem = useCallback(
    async (input: CreateItemInput): Promise<HttpItem> => {
      const res = await fetch("/api/http-collections/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw await parseError(res, "Failed to save item");
      const data = (await res.json()) as { item: HttpItem };
      await refetch();
      return data.item;
    },
    [refetch],
  );

  const updateItem = useCallback(
    async (id: string, patch: UpdateItemInput): Promise<HttpItem> => {
      const res = await fetch(`/api/http-collections/items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw await parseError(res, "Failed to update item");
      const data = (await res.json()) as { item: HttpItem };
      await refetch();
      return data.item;
    },
    [refetch],
  );

  const deleteItem = useCallback(
    async (id: string): Promise<{ id: string; unlinkedFrom: number }> => {
      const res = await fetch(`/api/http-collections/items/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw await parseError(res, "Failed to delete item");
      const data = (await res.json()) as { ok: true; id: string; unlinkedFrom: number };
      await refetch();
      return { id: data.id, unlinkedFrom: data.unlinkedFrom };
    },
    [refetch],
  );

  return {
    collections,
    items,
    joinRows,
    isLoading,
    error,
    refetch,
    createCollection,
    updateCollection,
    deleteCollection,
    createItem,
    updateItem,
    deleteItem,
  };
}
