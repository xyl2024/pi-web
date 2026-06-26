"use client";

// Dynamic wrapper for the Excalidraw canvas panel. The inner component
// imports `@excalidraw/excalidraw`, which touches `document` on mount and
// pulls in a ~2-3 MB JS payload, so we keep it out of the main bundle.
//
// Excalidraw's CSS is imported here explicitly rather than relying on the
// package's side-effect imports — Next.js Turbopack does not always hoist
// side-effect CSS out of a dynamic chunk, and without it the editor renders
// with collapsed dimensions.
//
// Mirrors the `components/RichTextEditor.tsx` pattern.

import type { ComponentType } from "react";
import dynamic from "next/dynamic";

import "@excalidraw/excalidraw/index.css";

export const CanvasPanel = dynamic(
  () => import("./CanvasPanelInner").then((m) => m.CanvasPanelInner),
  { ssr: false, loading: () => null },
) as ComponentType;