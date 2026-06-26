"use client";

// Dynamic wrapper for the Excalidraw canvas panel. The inner component
// imports `@excalidraw/excalidraw`, which touches `document` on mount and
// pulls in a ~2-3 MB JS payload, so we keep it out of the main bundle.
//
// Mirrors the `components/RichTextEditor.tsx` pattern.

import type { ComponentType } from "react";
import dynamic from "next/dynamic";

export const CanvasPanel = dynamic(
  () => import("./CanvasPanelInner").then((m) => m.CanvasPanelInner),
  { ssr: false, loading: () => null },
) as ComponentType;