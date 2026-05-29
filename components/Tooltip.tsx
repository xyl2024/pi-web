"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

interface Props {
  content: string;
  children: ReactNode;
}

export function Tooltip({ content, children }: Props) {
  return (
    <TooltipPrimitive.Provider delayDuration={500}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
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
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
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
