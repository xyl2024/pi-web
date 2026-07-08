"use client";

import { Tooltip } from "./Tooltip";

interface Props {
  unread: number;
  onClick: () => void;
  tooltip?: string;
}

export function InboxBell({ unread, onClick, tooltip = "Open inbox" }: Props) {
  return (
    <Tooltip content={tooltip}>
      <button
        onClick={onClick}
        aria-label={tooltip}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          padding: 0,
          flexShrink: 0,
          background: "none",
          border: "none",
          borderRadius: 7,
          color: "var(--text-muted)",
          cursor: "pointer",
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "none";
          e.currentTarget.style.color = "var(--text-muted)";
        }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              minWidth: 14,
              height: 14,
              padding: "0 4px",
              borderRadius: 7,
              background: "#ef4444",
              color: "#fff",
              fontSize: 9,
              fontWeight: 700,
              lineHeight: "14px",
              textAlign: "center",
              boxSizing: "border-box",
            }}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
    </Tooltip>
  );
}