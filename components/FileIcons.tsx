// File & folder icons for the sidebar file tree.
//
// Icons are sourced from vscode-icons (MIT, https://github.com/vscode-icons/vscode-icons)
// and served as static SVGs from /file-icons/*.svg. The icon set has ~1200 entries
// covering most common file types (React, Python, Go, Rust, Vue, etc.) plus folder
// variants. The lookup map (lib/file-icon-map.ts) is auto-generated from the
// vscode-icons source data.
//
// For files / folders not in the vscode-icons map we fall back to a minimal
// monochrome placeholder so the tree is never blank.

import {
  fileIconByName,
  fileIconByExt,
  fileIconCombos,
  folderIconByName,
  defaultFolderIcon,
  defaultFolderOpenIcon,
} from "@/lib/file-icon-map";

interface IconProps {
  size?: number;
}

const FILE_ICON_PREFIX = "/file-icons/file_type_";
const FOLDER_ICON_PREFIX = "/file-icons/folder_type_";

/** Build the /file-icons/*.svg URL for an icon name. vscode-icons stores the
 *  default fallback icons (`default_file`, `default_folder`,
 *  `default_root_folder`, …) at the root of /file-icons/ with no
 *  `file_type_` / `folder_type_` prefix; every other icon has the prefix. */
function iconUrl(name: string, kind: "file" | "folder"): string {
  if (name.startsWith("default_")) return `/file-icons/${name}.svg`;
  const prefix = kind === "file" ? FILE_ICON_PREFIX : FOLDER_ICON_PREFIX;
  return `${prefix}${name}.svg`;
}

/** Look up the vscode-icons icon name for a file. Returns the SVG stem (without
 *  the `file_type_` prefix) or null when the name doesn't match anything. */
export function lookupFileIconName(name: string): string | null {
  const lower = name.toLowerCase();
  // 1. Exact filename match (handles package.json, Dockerfile, .gitignore, etc.)
  if (Object.prototype.hasOwnProperty.call(fileIconByName, lower)) {
    return fileIconByName[lower];
  }
  const dot = lower.lastIndexOf(".");
  if (dot > 0) {
    const stem = lower.slice(0, dot);
    const ext = lower.slice(dot + 1);
    // 2. stem + allowed extensions combo (e.g. tsconfig.json, vite.config.ts)
    for (const c of fileIconCombos) {
      if (c.filename === stem && c.exts.includes(ext)) return c.icon;
    }
    // 3. Plain extension (tsx → reactts, py → python, …)
    if (Object.prototype.hasOwnProperty.call(fileIconByExt, ext)) {
      return fileIconByExt[ext];
    }
  } else if (dot === 0) {
    // 4. Dotfiles: ".env" → strip the leading dot, look up the rest as an
    //    extension (handles `.env`, `.gitignore` once the fileIconByName
    //    miss above fell through).
    const ext = lower.slice(1);
    if (Object.prototype.hasOwnProperty.call(fileIconByExt, ext)) {
      return fileIconByExt[ext];
    }
  }
  return null;
}

/** Look up the vscode-icons icon name for a folder (with optional `_opened`
 *  suffix when open). */
export function lookupFolderIconName(name: string, open: boolean): string | null {
  const lower = name.toLowerCase();
  const base = folderIconByName[lower];
  if (!base) return null;
  if (open) return base + "_opened";
  return base;
}

// ── Rendering ──────────────────────────────────────────────────────────────

function VscodeIcon({ src, size, title }: { src: string; size: number; title?: string }) {
  // Inline-rendered SVG so it follows CSS currentColor / var() when the icon
  // ships hardcoded fills we override at render time. `loading="lazy"` keeps
  // the explorer snappy when folders have many files.
  // <img> (not Next/Image): file tree icons are 14×14 px and not LCP-critical,
  // and <img> lets the browser cache the SVGs across sessions without per-icon
  // webpack ceremony.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      width={size}
      height={size}
      alt={title ?? ""}
      loading="lazy"
      draggable={false}
      style={{ display: "block", flexShrink: 0 }}
    />
  );
}

function FallbackFileIcon({ size }: { size: number }) {
  // Minimal monochrome file outline for files vscode-icons doesn't cover.
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 2h7l3 3v9H3V2Z"
        stroke="var(--text-dim)"
        strokeWidth="1"
        fill="var(--text-dim)"
        fillOpacity="0.08"
      />
      <path d="M10 2v3h3" stroke="var(--text-dim)" strokeWidth="1" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Render the file tree icon for `name`. Tries the vscode-icons set first and
 *  falls back to a monochrome outline when nothing matches. */
export function getFileIcon(name: string, size = 14): React.ReactNode {
  const iconName = lookupFileIconName(name);
  if (iconName) {
    return <VscodeIcon src={iconUrl(iconName, "file")} size={size} title={iconName} />;
  }
  return <FallbackFileIcon size={size} />;
}

/** Render the folder icon. Pass `name` so we can pick the matching icon
 *  (`src`, `node_modules`, `.github`, …); without it we show the default
 *  vscode-icons folder icon. */
export function FolderIcon({
  size = 14,
  open = false,
  name,
}: IconProps & { open?: boolean; name?: string }) {
  const matched = name ? lookupFolderIconName(name, open) : null;
  const fallback = open ? defaultFolderOpenIcon : defaultFolderIcon;
  const iconName = matched ?? fallback;
  return <VscodeIcon src={iconUrl(iconName, "folder")} size={size} title={iconName} />;
}
