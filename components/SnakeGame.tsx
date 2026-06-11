"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ── Constants ───────────────────────────────────────────────────────────
const COLS = 52;
const ROWS_PER_HEATMAP = 7;
const TOTAL_ROWS = ROWS_PER_HEATMAP * 2;
const TICK_MS = 400;
const SEGMENT_TRANSITION_MS = 300;
const FADE_MS = 200;
const FLASH_MS = 200;

// ── Types ───────────────────────────────────────────────────────────────
type HeatmapKind = "sessions" | "github";
type Direction = "up" | "down" | "left" | "right";
type Phase = "playing" | "fadingOut" | "dormant";

interface CellInfo {
  heatmap: HeatmapKind;
  col: number;
  cellRow: number;
  logicalRow: number;
  level: number;
  el: HTMLElement;
}

interface Segment {
  col: number;
  logicalRow: number;
}

interface Props {
  enabled: boolean;
}

// ── Pure helpers (no component state) ──────────────────────────────────
function cellKey(heatmap: HeatmapKind, col: number, cellRow: number): string {
  return `${heatmap}:${col},${cellRow}`;
}

function segmentHeatmap(seg: Segment): HeatmapKind {
  return seg.logicalRow >= ROWS_PER_HEATMAP ? "github" : "sessions";
}

function segmentCellRow(seg: Segment): number {
  return seg.logicalRow >= ROWS_PER_HEATMAP ? seg.logicalRow - ROWS_PER_HEATMAP : seg.logicalRow;
}

function isValidPos(col: number, logicalRow: number): boolean {
  return col >= 0 && col < COLS && logicalRow >= 0 && logicalRow < TOTAL_ROWS;
}

function step(seg: Segment, dir: Direction): Segment {
  switch (dir) {
    case "up":    return { col: seg.col, logicalRow: seg.logicalRow - 1 };
    case "down":  return { col: seg.col, logicalRow: seg.logicalRow + 1 };
    case "left":  return { col: seg.col - 1, logicalRow: seg.logicalRow };
    case "right": return { col: seg.col + 1, logicalRow: seg.logicalRow };
  }
}

const REVERSE: Record<Direction, Direction> = {
  up: "down", down: "up", left: "right", right: "left",
};

const ALL_DIRS: Direction[] = ["up", "down", "left", "right"];

function posKey(col: number, logicalRow: number): string {
  return `${col},${logicalRow}`;
}

/** BFS from the snake's head to the nearest reachable bright + uneaten cell.
 *  The snake is allowed to pass through its own body (no obstacle check) — the
 *  only constraint beyond the board envelope is "no instant 180° reverse" when
 *  the snake is longer than 1 segment, which prevents a visually jarring snap.
 *  Returns the first step direction along the shortest path, or null when no
 *  bright + uneaten cell exists at all. */
function findNextStep(
  head: Segment,
  currentDir: Direction,
  snake: Segment[],
  board: Map<string, CellInfo>,
  eaten: Set<string>,
): Direction | null {
  const headKey = posKey(head.col, head.logicalRow);
  const visited = new Set<string>([headKey]);
  // Queue holds {col, logicalRow, firstDir}; uses a head index to avoid the
  // O(n) cost of Array.shift on every pop.
  type Node = { col: number; logicalRow: number; firstDir: Direction };
  const queue: Node[] = [];
  const allowReverse = snake.length <= 1;
  for (const dir of ALL_DIRS) {
    if (!allowReverse && dir === REVERSE[currentDir]) continue;
    const next = step(head, dir);
    if (!isValidPos(next.col, next.logicalRow)) continue;
    const k = posKey(next.col, next.logicalRow);
    if (visited.has(k)) continue;
    visited.add(k);
    queue.push({ col: next.col, logicalRow: next.logicalRow, firstDir: dir });
  }
  for (let qh = 0; qh < queue.length; qh++) {
    const node = queue[qh];
    const hm: HeatmapKind = node.logicalRow >= ROWS_PER_HEATMAP ? "github" : "sessions";
    const cr = node.logicalRow >= ROWS_PER_HEATMAP ? node.logicalRow - ROWS_PER_HEATMAP : node.logicalRow;
    const cell = board.get(cellKey(hm, node.col, cr));
    if (cell && cell.level >= 1 && !eaten.has(cellKey(hm, node.col, cr))) {
      return node.firstDir;
    }
    for (const dir of ALL_DIRS) {
      const next = step({ col: node.col, logicalRow: node.logicalRow }, dir);
      if (!isValidPos(next.col, next.logicalRow)) continue;
      const k = posKey(next.col, next.logicalRow);
      if (visited.has(k)) continue;
      visited.add(k);
      queue.push({ col: next.col, logicalRow: next.logicalRow, firstDir: node.firstDir });
    }
  }
  return null;
}

function discoverCells(): Map<string, CellInfo> {
  const map = new Map<string, CellInfo>();
  const els = document.querySelectorAll<HTMLElement>("[data-cell]");
  els.forEach((el) => {
    const wrap = el.closest<HTMLElement>("[data-heatmap]");
    const heatmap = wrap?.getAttribute("data-heatmap") as HeatmapKind | undefined;
    if (heatmap !== "sessions" && heatmap !== "github") return;
    const col = Number(el.getAttribute("data-col"));
    const cellRow = Number(el.getAttribute("data-row"));
    if (Number.isNaN(col) || Number.isNaN(cellRow)) return;
    const level = Number(el.getAttribute("data-level") ?? "0");
    const logicalRow = heatmap === "github" ? cellRow + ROWS_PER_HEATMAP : cellRow;
    map.set(cellKey(heatmap, col, cellRow), {
      heatmap, col, cellRow, logicalRow, level, el,
    });
  });
  return map;
}

function spawnSnake(board: Map<string, CellInfo>): Segment {
  const dim: CellInfo[] = [];
  const all: CellInfo[] = [];
  board.forEach((c) => {
    all.push(c);
    if (c.level === 0) dim.push(c);
  });
  const pool = dim.length > 0 ? dim : all;
  const start = pool[Math.floor(Math.random() * pool.length)];
  return { col: start.col, logicalRow: start.logicalRow };
}

// ── Component ──────────────────────────────────────────────────────────
export function SnakeGame({ enabled }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // All mutable state in refs (mutated by tick, read in render).
  const boardRef = useRef<Map<string, CellInfo>>(new Map());
  const snakeRef = useRef<Segment[]>([]);
  const eatenRef = useRef<Set<string>>(new Set());
  const flashingRef = useRef<Set<string>>(new Set());
  const directionRef = useRef<Direction>("right");
  const containerRectRef = useRef<DOMRect | null>(null);

  // `phase` is the only state — drives the game-tick effect.
  const [phase, setPhase] = useState<Phase>("dormant");

  // Pauses the tick (but not the rest of the state) when the user hovers
  // over a heatmap. Re-evaluated on `phase` change so it binds after the
  // heatmaps are mounted and unbinds when the snake goes dormant.
  const [paused, setPaused] = useState(false);

  // Bump to force re-render on imperative updates (tick, resize, etc.).
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // ── Init / teardown on `enabled` change ──────────────────────────────
  useEffect(() => {
    if (!enabled) {
      setPhase("fadingOut");
      const t = window.setTimeout(() => {
        snakeRef.current = [];
        eatenRef.current = new Set();
        flashingRef.current = new Set();
        setPhase("dormant");
      }, FADE_MS);
      return () => window.clearTimeout(t);
    }
    let cancelled = false;
    let obs: MutationObserver | null = null;
    const tryInit = () => {
      if (cancelled) return true;
      boardRef.current = discoverCells();
      if (boardRef.current.size > 0) {
        snakeRef.current = [spawnSnake(boardRef.current)];
        eatenRef.current = new Set();
        flashingRef.current = new Set();
        directionRef.current = "right";
        setPhase("playing");
        bump();
        return true;
      }
      return false;
    };
    if (!tryInit()) {
      // Wait for the heatmaps to mount / finish loading.
      obs = new MutationObserver(() => {
        if (tryInit() && obs) obs.disconnect();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
    return () => {
      cancelled = true;
      if (obs) obs.disconnect();
    };
  }, [enabled, bump]);

  // ── Window-level position tracking (viewport changes) ────────────────
  useEffect(() => {
    const update = () => {
      if (containerRef.current) {
        containerRectRef.current = containerRef.current.getBoundingClientRect();
        bump();
      }
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update);
    };
  }, [bump]);

  // ── ResizeObserver on the heatmap cells (heatmaps can resize too) ────
  useEffect(() => {
    if (boardRef.current.size === 0) return;
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        containerRectRef.current = containerRef.current.getBoundingClientRect();
        bump();
      }
    });
    boardRef.current.forEach((c) => ro.observe(c.el));
    return () => ro.disconnect();
  });

  // ── Heatmap hover: pause the tick while the user is hovering ─────────
  useEffect(() => {
    if (phase === "dormant") return;
    const grids = document.querySelectorAll<HTMLElement>("[data-heatmap]");
    if (grids.length === 0) return;

    // If the cursor is already over a heatmap when we mount, start paused.
    if (Array.from(grids).some((g) => g.matches(":hover"))) setPaused(true);

    const onEnter = () => setPaused(true);
    const onLeave = () => setPaused(false);
    grids.forEach((g) => {
      g.addEventListener("mouseenter", onEnter);
      g.addEventListener("mouseleave", onLeave);
    });
    return () => {
      grids.forEach((g) => {
        g.removeEventListener("mouseenter", onEnter);
        g.removeEventListener("mouseleave", onLeave);
      });
    };
  }, [phase]);

  // Reset `paused` when the snake goes dormant so the next session starts unpaused.
  useEffect(() => {
    if (phase === "dormant") setPaused(false);
  }, [phase]);

  // ── Game tick ────────────────────────────────────────────────────────
  const tick = useCallback(() => {
    const s_board = boardRef.current;
    const s_snake = snakeRef.current;
    const s_eaten = eatenRef.current;
    const s_flashing = flashingRef.current;
    if (s_snake.length === 0) return;
    const head = s_snake[s_snake.length - 1];

    // Pick the next step: BFS to the nearest reachable bright + uneaten cell,
    // routing around the body. Returns null when there's nothing reachable —
    // either all bright cells have been eaten or the snake has trapped itself.
    const dir = findNextStep(head, directionRef.current, s_snake, s_board, s_eaten);
    if (dir === null) {
      setPhase("fadingOut");
      window.setTimeout(() => {
        snakeRef.current = [];
        eatenRef.current = new Set();
        flashingRef.current = new Set();
        setPhase("dormant");
      }, FADE_MS);
      return;
    }
    directionRef.current = dir;

    const nextSeg = step(head, dir);
    const headHeatmap = segmentHeatmap(nextSeg);
    const headCellRow = segmentCellRow(nextSeg);
    const newHeadCell = s_board.get(cellKey(headHeatmap, nextSeg.col, headCellRow));

    const newSnake: Segment[] = [...s_snake, nextSeg];
    let grew = false;
    if (newHeadCell) {
      const k = cellKey(newHeadCell.heatmap, newHeadCell.col, newHeadCell.cellRow);
      if (newHeadCell.level >= 1 && !s_eaten.has(k)) {
        s_eaten.add(k);
        s_flashing.add(k);
        grew = true;
        window.setTimeout(() => {
          s_flashing.delete(k);
          bump();
        }, FLASH_MS);
      }
    }
    if (!grew) newSnake.shift();
    snakeRef.current = newSnake;
    bump();
  }, [bump]);

  useEffect(() => {
    if (phase !== "playing" || paused) return;
    const id = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(id);
  }, [phase, paused, tick]);

  // ── Render ───────────────────────────────────────────────────────────
  if (phase === "dormant") return null;
  const rect = containerRectRef.current;

  if (!rect) {
    return (
      <div
        ref={containerRef}
        style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5, opacity: 0 }}
      />
    );
  }

  const opacity = phase === "fadingOut" ? 0 : 1;
  const transition = `opacity ${FADE_MS}ms ease`;

  return (
    <div
      ref={containerRef}
      style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5, opacity, transition }}
    >
      {/* Eaten cells: paint with the accent's complementary hue so they stay
          clearly visible and distinct from both live heatmap cells (accent-
          tinted) and the snake itself (solid accent). Uses CSS relative color
          syntax to derive the complement from `--accent` at run time, keeping
          the effect theme-aware. */}
      {Array.from(eatenRef.current).map((k) => {
        const cell = boardRef.current.get(k);
        if (!cell) return null;
        const r = cell.el.getBoundingClientRect();
        return (
          <div
            key={k}
            style={{
              position: "absolute",
              left: r.left - rect.left,
              top: r.top - rect.top,
              width: r.width,
              height: r.height,
              background: "hsl(from var(--accent) calc(h + 180) s l)",
              borderRadius: 2,
            }}
          />
        );
      })}

      {/* Brief flash overlay when a cell is first eaten. */}
      {Array.from(flashingRef.current).map((k) => {
        const cell = boardRef.current.get(k);
        if (!cell) return null;
        const r = cell.el.getBoundingClientRect();
        return (
          <div
            key={`flash-${k}`}
            style={{
              position: "absolute",
              left: r.left - rect.left,
              top: r.top - rect.top,
              width: r.width,
              height: r.height,
              background: "var(--accent)",
              borderRadius: 2,
              animation: `snake-eat-flash ${FLASH_MS}ms ease forwards`,
            }}
          />
        );
      })}

      {/* Snake body. Painted with the accent's complementary hue so the snake
          (= the leading edge of its eaten trail) visually merges with the
          already-eaten cells underneath instead of covering them in accent —
          which previously made the trail "disappear" wherever the body lay.
          Head uses `--accent-hover`'s complementary hue for a subtle highlight. */}
      {snakeRef.current.map((seg, i) => {
        const hm = segmentHeatmap(seg);
        const cr = segmentCellRow(seg);
        const cell = boardRef.current.get(cellKey(hm, seg.col, cr));
        if (!cell) return null;
        const r = cell.el.getBoundingClientRect();
        const isHead = i === snakeRef.current.length - 1;
        return (
          <div
            key={`seg-${i}-${hm}-${seg.col}-${seg.logicalRow}`}
            style={{
              position: "absolute",
              left: r.left - rect.left,
              top: r.top - rect.top,
              width: r.width,
              height: r.height,
              background: isHead
                ? "hsl(from var(--accent-hover) calc(h + 180) s l)"
                : "hsl(from var(--accent) calc(h + 180) s l)",
              borderRadius: 2,
              transition: `left ${SEGMENT_TRANSITION_MS}ms ease, top ${SEGMENT_TRANSITION_MS}ms ease`,
              boxShadow: isHead ? "0 0 0 1px var(--bg)" : undefined,
            }}
          />
        );
      })}
    </div>
  );
}
