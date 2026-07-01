"use client";

import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { useTheme } from "@/hooks/useTheme";

interface Props {
  code: string;
}

/**
 * Read-only, header-less JSON syntax highlighter used by the HTTP body
 * editor (overlay behind a transparent textarea) and by anything else that
 * wants color-coded JSON without the CodeBlock wrapper's header bar and
 * copy button. Theme follows the global theme via useTheme().isDark.
 */
export function JsonHighlight({ code }: Props) {
  const { isDark } = useTheme();
  return (
    <SyntaxHighlighter
      language="json"
      style={isDark ? vscDarkPlus : vs}
      PreTag="div"
      showLineNumbers={false}
      customStyle={{ margin: 0, padding: 0, background: "transparent", border: 0, outline: "none", boxShadow: "none" }}
      codeTagProps={{ style: { fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5, border: 0, outline: "none", boxShadow: "none" } }}
    >
      {code}
    </SyntaxHighlighter>
  );
}
