"use client";

/**
 * Drawer content for the HTTP Panel Collections feature.
 *
 * Renders a collection-grouped tree (E1): each collection is a collapsible
 * row, items inside are sub-rows. Top fixed search input (F1) filters by
 * name / url / method / tags case-insensitively.
 *
 * Per-row actions live in a small click-popover (Edit / Delete). The popover
 * closes on outside-mousedown or Escape.
 *
 * All data + CRUD callbacks are injected as props; this component owns only
 * local UI state (search term, expanded set, open popover, inline new-
 * collection form).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type {
  Collection,
  CollectionItemJoinRow,
  HttpItem,
} from "@/lib/http-collections-schema";
import type { HttpMethod } from "@/hooks/httpStore";

const METHOD_COLORS: Record<HttpMethod, string> = {
  GET: "var(--accent)",
  POST: "#16a34a",
  PUT: "#f59e0b",
  PATCH: "#f59e0b",
  DELETE: "#ef4444",
  HEAD: "var(--text-muted)",
  OPTIONS: "var(--text-muted)",
};

export interface HttpPanelCollectionsProps {
  collections: Collection[];
  items: HttpItem[];
  joinRows: CollectionItemJoinRow[];
  onLoadItem: (item: HttpItem) => void;
  onEditItem: (item: HttpItem) => void;
  onDeleteItem: (item: HttpItem) => Promise<void>;
  onCreateCollection: (name: string) => Promise<Collection | null>;
  onEditCollection: (collection: Collection) => void;
  onDeleteCollection: (
    collection: Collection,
    itemCount: number,
  ) => Promise<void>;
}

interface OpenMenu {
  kind: "collection" | "item";
  id: string;
}

function matchesSearch(haystack: string | undefined, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle);
}

function itemMatchesSearch(item: HttpItem, needle: string): boolean {
  if (!needle) return true;
  if (matchesSearch(item.name, needle)) return true;
  if (matchesSearch(item.url, needle)) return true;
  if (matchesSearch(item.method, needle)) return true;
  for (const tag of item.tags) {
    if (matchesSearch(tag, needle)) return true;
  }
  return false;
}

export function HttpPanelCollections({
  collections,
  items,
  joinRows,
  onLoadItem,
  onEditItem,
  onDeleteItem,
  onCreateCollection,
  onEditCollection,
  onDeleteCollection,
}: HttpPanelCollectionsProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [newCollectionError, setNewCollectionError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Close popover on outside mousedown / Escape
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setOpenMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  // Compute items per collection, sorted by createdAt ASC
  const itemsByCollection = useMemo(() => {
    const map = new Map<string, HttpItem[]>();
    const itemMap = new Map(items.map((i) => [i.id, i]));
    for (const j of joinRows) {
      const item = itemMap.get(j.itemId);
      if (!item) continue;
      const arr = map.get(j.collectionId) ?? [];
      arr.push(item);
      map.set(j.collectionId, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.createdAt - b.createdAt);
    }
    return map;
  }, [items, joinRows]);

  const sortedCollections = useMemo(
    () => [...collections].sort((a, b) => a.createdAt - b.createdAt),
    [collections],
  );

  const filteredCollections = useMemo(() => {
    if (!search.trim()) return sortedCollections;
    const needle = search.toLowerCase();
    return sortedCollections.filter((c) => {
      if (matchesSearch(c.name, needle)) return true;
      if (matchesSearch(c.description, needle)) return true;
      const its = itemsByCollection.get(c.id) ?? [];
      return its.some((i) => itemMatchesSearch(i, needle));
    });
  }, [sortedCollections, itemsByCollection, search]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreateCollection = async () => {
    const trimmed = newCollectionName.trim();
    if (trimmed.length === 0) return;
    setNewCollectionError(null);
    try {
      const created = await onCreateCollection(trimmed);
      if (created) {
        setNewCollectionName("");
        setShowNewCollection(false);
        // Auto-expand the new collection
        setExpanded((prev) => new Set(prev).add(created.id));
      }
    } catch (e) {
      setNewCollectionError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      style={{
        width: 240,
        height: "100%",
        background: "var(--bg)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          height: 32,
          padding: "0 8px 0 12px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
          {t("Collections")}
        </span>
        <button
          type="button"
          onClick={() => {
            setShowNewCollection((v) => !v);
            setNewCollectionError(null);
          }}
          aria-label={t("New collection")}
          title={t("New collection")}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            padding: 2,
            borderRadius: 4,
          }}
        >
          +
        </button>
      </div>

      {/* Search */}
      <div
        style={{
          padding: "6px 8px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          position: "relative",
        }}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("Search collections...")}
          style={{
            width: "100%",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "4px 24px 4px 8px",
            fontSize: 12,
            color: "var(--text)",
            outline: "none",
            fontFamily: "var(--font-sans)",
          }}
        />
        {search.length > 0 && (
          <button
            type="button"
            onClick={() => setSearch("")}
            aria-label={t("Close")}
            style={{
              position: "absolute",
              right: 12,
              top: "50%",
              transform: "translateY(-50%)",
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        )}
      </div>

      {/* Inline new-collection form */}
      {showNewCollection && (
        <div
          style={{
            padding: 8,
            borderBottom: "1px solid var(--border)",
            display: "flex",
            gap: 4,
            flexShrink: 0,
          }}
        >
          <input
            autoFocus
            type="text"
            value={newCollectionName}
            onChange={(e) => setNewCollectionName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreateCollection();
              } else if (e.key === "Escape") {
                setShowNewCollection(false);
                setNewCollectionName("");
                setNewCollectionError(null);
              }
            }}
            placeholder={t("New collection name")}
            style={{
              flex: 1,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "4px 6px",
              fontSize: 12,
              color: "var(--text)",
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={() => void handleCreateCollection()}
            disabled={newCollectionName.trim().length === 0}
            style={{
              background: newCollectionName.trim().length > 0
                ? "var(--accent)"
                : "var(--bg-subtle)",
              color: newCollectionName.trim().length > 0
                ? "var(--bg)"
                : "var(--text-muted)",
              border: "none",
              borderRadius: 4,
              padding: "4px 8px",
              fontSize: 11,
              fontWeight: 600,
              cursor: newCollectionName.trim().length > 0 ? "pointer" : "not-allowed",
            }}
          >
            {t("Add")}
          </button>
        </div>
      )}
      {newCollectionError && (
        <div
          style={{
            color: "#ef4444",
            fontSize: 11,
            padding: "4px 8px",
            flexShrink: 0,
          }}
        >
          {newCollectionError}
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
        {sortedCollections.length === 0 ? (
          <div
            style={{
              padding: "32px 16px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 12,
            }}
          >
            <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.5 }}>📁</div>
            <div style={{ marginBottom: 4 }}>{t("No collections yet")}</div>
            <div style={{ fontSize: 11, opacity: 0.7 }}>
              {t("Click + to start")}
            </div>
          </div>
        ) : (
          filteredCollections.map((c) => {
            const allItems = itemsByCollection.get(c.id) ?? [];
            const filteredItems = search.trim()
              ? allItems.filter((i) => itemMatchesSearch(i, search.toLowerCase()))
              : allItems;
            const isExpanded = expanded.has(c.id) || (search.trim().length > 0);
            const isMenuOpen =
              openMenu?.kind === "collection" && openMenu.id === c.id;
            return (
              <div key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                {/* Collection header */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "6px 8px",
                    gap: 4,
                    background: isMenuOpen ? "var(--bg-hover)" : "transparent",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleExpanded(c.id)}
                    aria-label={isExpanded ? t("Collapse") : t("Expand")}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 10,
                      padding: 0,
                      width: 14,
                      lineHeight: 1,
                    }}
                  >
                    {isExpanded ? "▼" : "▶"}
                  </button>
                  <span
                    onClick={() => toggleExpanded(c.id)}
                    style={{
                      flex: 1,
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--text)",
                      cursor: "pointer",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.name}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--text-muted)",
                      background: "var(--bg-subtle)",
                      borderRadius: 8,
                      padding: "1px 6px",
                    }}
                  >
                    {allItems.length}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenu(
                        isMenuOpen
                          ? null
                          : { kind: "collection", id: c.id },
                      );
                    }}
                    aria-label={t("More")}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 14,
                      padding: 0,
                      lineHeight: 1,
                      width: 16,
                    }}
                  >
                    ⋯
                  </button>
                  {isMenuOpen && (
                    <div
                      ref={popoverRef}
                      style={popoverStyle}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          onEditCollection(c);
                        }}
                        style={menuItemStyle}
                      >
                        {t("Edit collection")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          void onDeleteCollection(c, allItems.length);
                        }}
                        style={{ ...menuItemStyle, color: "#ef4444" }}
                      >
                        {t("Delete collection")}
                      </button>
                    </div>
                  )}
                </div>

                {/* Items */}
                {isExpanded && (
                  <div>
                    {filteredItems.length === 0 ? (
                      <div
                        style={{
                          padding: "4px 12px 6px 24px",
                          color: "var(--text-muted)",
                          fontSize: 11,
                          fontStyle: "italic",
                        }}
                      >
                        {search.trim() ? t("No matches") : t("No items in this collection")}
                      </div>
                    ) : (
                      filteredItems.map((item) => {
                        const itemMenuOpen =
                          openMenu?.kind === "item" && openMenu.id === item.id;
                        return (
                          <div
                            key={item.id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              padding: "4px 8px 4px 24px",
                              gap: 6,
                              position: "relative",
                            }}
                          >
                            <span
                              onClick={() => onLoadItem(item)}
                              style={{
                                fontSize: 9,
                                fontWeight: 700,
                                color: METHOD_COLORS[item.method] ?? "var(--text-muted)",
                                fontFamily: "var(--font-mono)",
                                width: 38,
                                flexShrink: 0,
                                cursor: "pointer",
                              }}
                            >
                              {item.method}
                            </span>
                            <span
                              onClick={() => onLoadItem(item)}
                              style={{
                                flex: 1,
                                fontSize: 12,
                                color: "var(--text)",
                                cursor: "pointer",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {item.name}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenu(
                                  itemMenuOpen
                                    ? null
                                    : { kind: "item", id: item.id },
                                );
                              }}
                              aria-label={t("More")}
                              style={{
                                background: "transparent",
                                border: "none",
                                color: "var(--text-muted)",
                                cursor: "pointer",
                                fontSize: 14,
                                padding: 0,
                                lineHeight: 1,
                                width: 16,
                              }}
                            >
                              ⋯
                            </button>
                            {itemMenuOpen && (
                              <div
                                ref={popoverRef}
                                style={{ ...popoverStyle, right: 4, top: 22 }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenMenu(null);
                                    onEditItem(item);
                                  }}
                                  style={menuItemStyle}
                                >
                                  {t("Edit item")}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenMenu(null);
                                    void onDeleteItem(item);
                                  }}
                                  style={{ ...menuItemStyle, color: "#ef4444" }}
                                >
                                  {t("Delete item")}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const popoverStyle: React.CSSProperties = {
  position: "absolute",
  right: 8,
  top: 28,
  zIndex: 100,
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
  display: "flex",
  flexDirection: "column",
  minWidth: 140,
  padding: 2,
};

const menuItemStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text)",
  textAlign: "left",
  padding: "6px 10px",
  fontSize: 12,
  cursor: "pointer",
  borderRadius: 3,
  fontFamily: "var(--font-sans)",
};
