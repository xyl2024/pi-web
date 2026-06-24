"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { Locale } from "@/hooks/useI18n";

export type ThemePreset = "default" | "midnight" | "synthwave" | "forest" | "sepia";

export const PRESETS: ThemePreset[] = ["default", "midnight", "synthwave", "forest", "sepia"];

export const PRESET_LABELS: Record<ThemePreset, Record<Locale, string>> = {
  default: { en: "Default", zh: "默认" },
  midnight: { en: "Midnight", zh: "暗夜" },
  synthwave: { en: "Synthwave", zh: "赛博" },
  forest: { en: "Forest", zh: "森林" },
  sepia: { en: "Sepia", zh: "羊皮" },
};

/** Whether a preset uses dark background tones — used for syntax-highlighter themes. */
export const PRESET_IS_DARK: Record<ThemePreset, boolean> = {
  default: false,
  midnight: true,
  synthwave: true,
  forest: false,
  sepia: false,
};

const PRESET_CLASS: Record<ThemePreset, string> = {
  default: "theme-default",
  midnight: "theme-midnight",
  synthwave: "theme-synthwave",
  forest: "theme-forest",
  sepia: "theme-sepia",
};

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getSnapshot(): ThemePreset {
  if (typeof document === "undefined") return "default";
  for (const preset of PRESETS) {
    if (document.documentElement.classList.contains(PRESET_CLASS[preset])) return preset;
  }
  return "default";
}

function getServerSnapshot(): ThemePreset {
  return "default";
}

type ToggleOrigin = { x: number; y: number };

export function useTheme() {
  const preset = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setPreset = useCallback((next: ThemePreset, origin?: ToggleOrigin) => {
    const apply = () => {
      // Remove all preset classes, then add the new one
      for (const cls of Object.values(PRESET_CLASS)) {
        document.documentElement.classList.remove(cls);
      }
      document.documentElement.classList.add(PRESET_CLASS[next]);
      try { localStorage.setItem("pi-theme", next); } catch { /* ignore */ }
      listeners.forEach((cb) => cb());
    };

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const supportsVT = typeof document.startViewTransition === "function";

    if (!supportsVT || reduceMotion) { apply(); return; }

    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? window.innerHeight / 2;
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );

    const transition = document.startViewTransition(apply);
    transition.ready
      .then(() => {
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${endRadius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 450,
            easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => { /* transition cancelled — ignore */ });
  }, []);

  const cycleTheme = useCallback((origin?: ToggleOrigin) => {
    const idx = PRESETS.indexOf(preset);
    const next = PRESETS[(idx + 1) % PRESETS.length];
    setPreset(next, origin);
  }, [preset, setPreset]);

  return {
    preset,
    setPreset,
    cycleTheme,
    isDark: PRESET_IS_DARK[preset],
  };
}