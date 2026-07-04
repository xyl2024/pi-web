"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";

const SPEEDS = [0.5, 1, 1.5, 2] as const;
const BASE_TICK_MS = 700;

interface ReplayBarProps {
  /** Total number of messages in the session (slider max). */
  total: number;
  /** Current cutoff N — the chat renders messages[0..N]. */
  index: number;
  playing: boolean;
  speed: number;
  /** Pre-formatted "12 / 47 · 14:23:01". */
  positionLabel: string;
  onIndexChange: (n: number) => void;
  onPlayingChange: (p: boolean) => void;
  onSpeedChange: (s: number) => void;
  onClose: () => void;
}

/**
 * Message-level "time travel" scrubber. Purely presentational + owns its own
 * playback clock; all replay state lives in ChatWindow. Reuses the scrubber /
 * IconButton interaction language from AudioPlayer.
 */
export function ReplayBar({
  total, index, playing, speed, positionLabel,
  onIndexChange, onPlayingChange, onSpeedChange, onClose,
}: ReplayBarProps) {
  const { t } = useI18n();
  const groupRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  // Focus the bar on open so Space / Esc / Arrow keys work immediately.
  useEffect(() => {
    groupRef.current?.focus();
  }, []);

  // Playback clock: advance one message per tick while playing; stop at the end.
  // Depending on `index` re-arms the timer each tick (self-rescheduling), so
  // there is no interval drift.
  useEffect(() => {
    if (!playing) return;
    if (index >= total) {
      onPlayingChange(false);
      return;
    }
    const id = setInterval(() => {
      onIndexChange(Math.min(index + 1, total));
    }, BASE_TICK_MS / speed);
    return () => clearInterval(id);
  }, [playing, index, total, speed, onIndexChange, onPlayingChange]);

  const seekFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el || total <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onIndexChange(Math.round(ratio * total));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (total <= 0) return;
    draggingRef.current = true;
    onPlayingChange(false);
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    seekFromClientX(e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const togglePlay = () => {
    // Restart from the beginning if we're parked at the end.
    if (index >= total) onIndexChange(0);
    onPlayingChange(!playing);
  };

  // Nudge the cutoff by one message. Manual stepping pauses playback so the
  // user keeps precise control (same rationale as scrubbing).
  const stepBack = () => {
    onPlayingChange(false);
    onIndexChange(Math.max(0, index - 1));
  };
  const stepForward = () => {
    onPlayingChange(false);
    onIndexChange(Math.min(total, index + 1));
  };

  const cycleSpeed = () => {
    const i = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
    onSpeedChange(SPEEDS[(i + 1) % SPEEDS.length]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      stepBack();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      stepForward();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const ratio = total > 0 ? Math.max(0, Math.min(1, index / total)) : 0;

  return (
    <div
      ref={groupRef}
      role="group"
      aria-label={t("Replay")}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "5px 12px",
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        fontFamily: "var(--font-mono)",
        outline: "none",
        flexShrink: 0,
      }}
    >
      <IconButton
        onClick={stepBack}
        disabled={index <= 0}
        ariaLabel={t("Step back")}
        title={t("Step back")}
      >
        ◀
      </IconButton>

      <IconButton
        onClick={togglePlay}
        ariaLabel={playing ? t("Pause") : t("Play")}
        title={playing ? t("Pause") : t("Play")}
        primary
      >
        {playing ? "❚❚" : "▶"}
      </IconButton>

      <IconButton
        onClick={stepForward}
        disabled={index >= total}
        ariaLabel={t("Step forward")}
        title={t("Step forward")}
      >
        ▶
      </IconButton>

      <IconButton
        onClick={cycleSpeed}
        ariaLabel={t("Speed")}
        title={t("Speed")}
        style={{ minWidth: 42 }}
      >
        {speed}×
      </IconButton>

      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="slider"
        aria-label={t("Seek")}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={index}
        tabIndex={0}
        style={{
          position: "relative",
          flex: 1,
          height: 6,
          borderRadius: 3,
          background: "var(--bg-subtle)",
          cursor: total > 0 ? "pointer" : "default",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            bottom: 0,
            width: `${ratio * 100}%`,
            background: "var(--accent)",
            transition: draggingRef.current ? "none" : "width 0.08s linear",
          }}
        />
      </div>

      <span
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {positionLabel}
      </span>

      <IconButton onClick={onClose} ariaLabel={t("Close replay")} title={t("Close replay")}>
        ✕
      </IconButton>
    </div>
  );
}

function IconButton({
  onClick,
  disabled,
  ariaLabel,
  title,
  primary,
  children,
  style,
}: {
  onClick: () => void;
  disabled?: boolean;
  ariaLabel: string;
  title: string;
  primary?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      style={{
        height: 26,
        minWidth: 26,
        padding: "0 8px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        background: primary ? "var(--accent)" : "var(--bg-subtle)",
        color: primary ? "var(--bg)" : "var(--text)",
        border: "1px solid var(--border)",
        borderRadius: 5,
        fontSize: 12,
        lineHeight: 1,
        fontFamily: "var(--font-mono)",
        transition: "background 0.1s ease-out, color 0.1s ease-out",
        ...style,
      }}
    >
      {children}
    </button>
  );
}
