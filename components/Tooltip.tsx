"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

interface Props {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  delayDuration?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Tooltip({ content, children, side, align, delayDuration = 500, open, onOpenChange }: Props) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <TooltipPrimitive.Trigger asChild>
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={5}
            style={{
              zIndex: 9999,
              maxWidth: 280,
              padding: "4px 10px",
              background: "var(--bg-panel)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.5,
              fontFamily: "var(--font-sans)",
              boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
              animation: "tooltip-in 200ms ease",
            }}
          >
            {content}
            <TooltipPrimitive.Arrow
              style={{ fill: "var(--bg-panel)", stroke: "var(--border)", strokeWidth: 1 }}
              width={8}
              height={4}
            />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
