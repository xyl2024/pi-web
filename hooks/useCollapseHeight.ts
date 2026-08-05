"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Drives the height of an expand/collapse container. CSS can't transition
 * `auto`, so the rendered content height is measured via ResizeObserver and
 * exposed as a pixel value for the container's `height` style. Transitions
 * stay off until the first measure so mounting never pops, and content
 * changes (streaming growth, images loading) re-trigger the animation.
 */
export function useCollapseHeight<T extends HTMLElement>() {
  const contentRef = useRef<T>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [allowAnim, setAllowAnim] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setAllowAnim(true));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const update = () => setContentHeight((prev) => (prev === el.scrollHeight ? prev : el.scrollHeight));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { contentRef, contentHeight, allowAnim };
}
