"use client";

import { useEffect, useRef, useState } from "react";

/**
 * One-shot idle trigger: returns `true` after `timeoutMs` of no click on any
 * element with `data-heatmap` (i.e. on a heatmap cell grid). Once `true`,
 * subsequent clicks do not reset the state — callers should treat this as a
 * start signal, not a stop signal. The hook resets to `false` when `enabled`
 * becomes `false`.
 *
 * Other user activity (mouse move, key press, scroll, typing) is ignored by
 * design — only heatmap clicks count toward the countdown.
 */
export function useIdle(timeoutMs: number, enabled: boolean = true): boolean {
  const [triggered, setTriggered] = useState(false);
  const triggeredRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setTriggered(false);
      triggeredRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    const arm = () => {
      if (triggeredRef.current) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        triggeredRef.current = true;
        setTriggered(true);
      }, timeoutMs);
    };

    const onClick = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && t.closest("[data-heatmap]")) {
        arm();
      }
    };

    arm();
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [timeoutMs, enabled]);

  return triggered;
}
