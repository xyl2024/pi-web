"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  src: string;
  /** Display title (typically the file path). Shown truncated in the header. */
  title?: string;
  /** Optional small caption shown next to the title. */
  subtitle?: string;
  /**
   * URL of an image to use as the vinyl disc artwork. The image rotates
   * together with the disc. Defaults to `/record.jpg` from `public/`.
   */
  cover?: string;
}

const SPEEDS = [0.5, 1, 1.5, 2] as const;
const MIN_WIDTH_FOR_SCRUBBER = 360;
const DEFAULT_COVER = "/record.jpg";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Custom audio player used by show_file for audio files. Wraps a hidden
 * native <audio> element and renders progress / time / speed / volume
 * controls in a card that matches the rest of ShowFileRenderer.
 */
export function AudioPlayer({ src, title, subtitle, cover = DEFAULT_COVER }: Props) {
  const { t } = useI18n();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  // Track the time the user is dragging to without fighting the audio element.
  const [dragTime, setDragTime] = useState<number | null>(null);
  const scrubberRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const onLoaded = () => {
      setReady(true);
      setDuration(Number.isFinite(el.duration) ? el.duration : 0);
      setError(null);
    };
    const onTime = () => {
      if (!scrubbing) setCurrent(el.currentTime);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setCurrent(el.duration || 0);
    };
    const onError = () => {
      setError(t("Failed to load audio"));
      setReady(false);
    };
    const onVolume = () => {
      setVolume(el.volume);
      setMuted(el.muted);
    };

    el.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    el.addEventListener("volumechange", onVolume);
    return () => {
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
      el.removeEventListener("volumechange", onVolume);
    };
  }, [scrubbing, t]);

  // Apply playback rate changes when the user picks a new speed.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = speed;
  }, [speed, ready]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
    } else {
      el.pause();
    }
  }, []);

  const seekTo = useCallback(
    (ratio: number) => {
      const el = audioRef.current;
      if (!el || !duration) return;
      const clamped = Math.max(0, Math.min(1, ratio));
      const next = clamped * duration;
      el.currentTime = next;
      setCurrent(next);
    },
    [duration],
  );

  const onScrubberPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ready || !scrubberRef.current) return;
    setScrubbing(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    setDragTime(ratio * duration);
  };
  const onScrubberPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing || !scrubberRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    setDragTime(Math.max(0, Math.min(1, ratio)) * duration);
  };
  const onScrubberPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setScrubbing(false);
    if (dragTime != null) seekTo(dragTime / duration);
    setDragTime(null);
  };

  const onVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = audioRef.current;
    if (!el) return;
    const next = Number.parseFloat(e.target.value);
    el.volume = next;
    if (next > 0 && el.muted) el.muted = false;
  };

  const toggleMute = () => {
    const el = audioRef.current;
    if (!el) return;
    el.muted = !el.muted;
  };

  const cycleSpeed = () => {
    const idx = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    setSpeed(next);
  };

  // Spacebar plays/pauses when the player container has focus.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      togglePlay();
    }
  };

  const displayCurrent = scrubbing && dragTime != null ? dragTime : current;
  const progressRatio = duration > 0 ? displayCurrent / duration : 0;

  return (
    <div
      role="group"
      aria-label={title ?? "audio"}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "12px 14px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        minWidth: MIN_WIDTH_FOR_SCRUBBER,
        fontFamily: "var(--font-mono)",
        outline: "none",
      }}
    >
      <audio ref={audioRef} src={src} preload="metadata" />

      {/* Vinyl disc: large circular record that spins while playing. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 140,
            height: 140,
            borderRadius: "50%",
            // Base disc body — dark fallback under the cover image, with
            // concentric grooves drawn as repeating radial gradients.
            background: [
              "repeating-radial-gradient(circle at center, rgba(255,255,255,0.06) 0 1px, transparent 1px 6px)",
              "#0d0d0d",
            ].join(", "),
            boxShadow:
              "0 4px 14px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.04)",
            position: "relative",
            flexShrink: 0,
            overflow: "hidden",
            // Inline animation so it survives CSS purging. Pausing is
            // controlled by `animationPlayState` on a style recalc.
            animation: "audioDiscSpin 6s linear infinite",
            animationPlayState: playing ? "running" : "paused",
          }}
        >
          {/* Cover artwork — fills the disc and rotates with it. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={cover}
            alt=""
            draggable={false}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              pointerEvents: "none",
              userSelect: "none",
            }}
          />
          {/* Center label: small spindle dot on top of the cover. */}
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              width: 14,
              height: 14,
              borderRadius: "50%",
              transform: "translate(-50%, -50%)",
              background: "var(--bg)",
              boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.4)",
            }}
          />
        </div>
        <div
          style={{
            minWidth: 0,
            width: "100%",
            textAlign: "center",
          }}
        >
          <div
            title={title}
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title ?? "audio"}
          </div>
          {subtitle && (
            <div
              style={{
                fontSize: 11,
                color: "var(--text-dim)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
      </div>

      {/* Error / loading banner */}
      {error && (
        <div
          style={{
            color: "#f87171",
            fontSize: 12,
            padding: "6px 8px",
            border: "1px solid rgba(248,113,113,0.3)",
            borderRadius: 5,
            background: "rgba(248,113,113,0.05)",
          }}
        >
          {error}
        </div>
      )}

      {/* Scrubber + time */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-dim)",
            width: 44,
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {formatTime(displayCurrent)}
        </span>
        <div
          ref={scrubberRef}
          onPointerDown={onScrubberPointerDown}
          onPointerMove={onScrubberPointerMove}
          onPointerUp={onScrubberPointerUp}
          onPointerCancel={onScrubberPointerUp}
          role="slider"
          aria-label={t("Seek")}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, Math.floor(duration))}
          aria-valuenow={Math.floor(displayCurrent)}
          tabIndex={0}
          style={{
            position: "relative",
            flex: 1,
            height: 6,
            borderRadius: 3,
            background: "var(--bg-subtle)",
            cursor: ready ? "pointer" : "default",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              bottom: 0,
              width: `${Math.max(0, Math.min(1, progressRatio)) * 100}%`,
              background: "var(--accent)",
              transition: scrubbing ? "none" : "width 0.08s linear",
            }}
          />
        </div>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-dim)",
            width: 44,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {formatTime(duration)}
        </span>
      </div>

      {/* Controls — centered horizontally as a single row. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <IconButton
          onClick={togglePlay}
          disabled={!ready}
          ariaLabel={playing ? t("Pause") : t("Play")}
          title={playing ? t("Pause") : t("Play")}
          primary
        >
          {playing ? "❚❚" : "▶"}
        </IconButton>

        <IconButton
          onClick={cycleSpeed}
          ariaLabel={t("Speed")}
          title={t("Speed")}
          style={{ minWidth: 44 }}
        >
          {speed}×
        </IconButton>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 120,
          }}
        >
          <IconButton
            onClick={toggleMute}
            ariaLabel={muted || volume === 0 ? t("Unmute") : t("Mute")}
            title={muted || volume === 0 ? t("Unmute") : t("Mute")}
          >
            {muted || volume === 0 ? "🔇" : "🔊"}
          </IconButton>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={onVolumeChange}
            aria-label={t("Volume")}
            style={{
              flex: 1,
              accentColor: "var(--accent)",
              height: 4,
              cursor: "pointer",
            }}
          />
        </div>
      </div>
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
        height: 28,
        minWidth: 28,
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
