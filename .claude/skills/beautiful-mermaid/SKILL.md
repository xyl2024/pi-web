---
name: beautiful-mermaid
description: Use this skill whenever you are about to write a ```mermaid code block in pi-web. beautiful-mermaid (the renderer pi-web uses, in place of mermaid 11) supports only 6 diagram types: `graph`/`flowchart`, `stateDiagram-v2`, `sequenceDiagram`, `classDiagram`, `erDiagram`, and `xychart-beta`. It does NOT support `gitGraph`, `mindmap`, `timeline`, `sankey-beta`, `pie`, `C4Context`/`C4Container`/`C4Component`/`C4Dynamic`, `packet`, `architecture-beta`, `journey`, `requirementDiagram`, `quadrantChart`, or `block-beta` — those will fail to render in pi-web. Trigger this skill proactively when the user asks for any "diagram", "chart", "visualization", "schema", 流程图 / 时序图 / 类图 / ER 图 / 状态图 / 架构图, or when the user reports a Mermaid block isn't rendering. When the natural diagram type is unsupported, swap to the closest supported type and tell the user explicitly (e.g., "Used a flowchart with subgraphs because beautiful-mermaid doesn't support C4.").
---

# beautiful-mermaid skill

## The one thing you must remember

**pi-web renders Mermaid with `beautiful-mermaid`, not mermaid 11.** The library supports **6 diagram types only**, hard-coded in its TypeScript types (`third/beautiful-mermaid/src/index.ts:54`):

```ts
function detectDiagramType(text: string): 'flowchart' | 'sequence' | 'class' | 'er' | 'xychart'
```

Anything else falls through to `'flowchart'`, gets parsed as a flowchart, and throws on the first unfamiliar keyword. **This is a library limitation, not a pi-web bug** — `components/MermaidBlock.tsx` is a thin pass-through with no type-specific logic, so pi-web can't work around it. The only way to get a rendering is to not emit these types in the first place.

| Supported | Not supported (will fail) |
|---|---|
| `graph` / `flowchart` (incl. state diagrams) | `gitGraph`, `mindmap`, `timeline`, `sankey-beta` |
| `sequenceDiagram` | `pie`, `quadrantChart`, `block-beta` |
| `classDiagram` | `C4Context` / `C4Container` / `C4Component` / `C4Dynamic` |
| `erDiagram` | `packet`, `architecture-beta` |
| `xychart-beta` | `journey`, `requirementDiagram` |

**Important:** "Mermaid syntax" is not the same as "beautiful-mermaid syntax". The Mermaid docs describe 20+ diagram types; beautiful-mermaid implements 6. Don't assume that a valid Mermaid block is valid beautiful-mermaid.

If you emit a code block whose first non-comment line is one of the **right column** types, the user sees the raw source plus a red error banner with the parser's complaint (e.g. `Failed to render Mermaid diagram — Unexpected token 'group' at line 2`). **Don't do that.**

## When to trigger this skill

You MUST consult this skill before emitting a ```mermaid block. Concretely:

- The user asks for a "diagram", "chart", "graph", "schema", 流程图 / 时序图 / 类图 / ER 图 / 状态图 / 架构图, etc.
- You're about to visualize an architecture, workflow, data model, state machine, sequence of calls, class hierarchy, database schema, or numeric trend.
- The user pastes a Mermaid block and asks you to fix it, or reports "the diagram doesn't show up".

If you're not sure whether the user wants a Mermaid block, **err on the side of triggering** — it's cheap to check.

## Decision flow

1. **Identify the natural type from the user's intent.** Defaults:
   - Process / control flow / decision tree → `graph TD` (see `references/flowchart.md`)
   - Time-ordered interactions → `sequenceDiagram` (see `references/sequence.md`)
   - Object-oriented structure / design pattern → `classDiagram` (see `references/class.md`)
   - Database schema → `erDiagram` (see `references/er.md`)
   - State machine → `stateDiagram-v2` (see `references/state.md`)
   - Numeric chart → `xychart-beta` (see `references/xychart.md`)

2. **Is the natural type in the not-supported column?** If yes, swap per the table in `references/swaps.md` and tell the user.

3. **Load the matching reference** for the chosen type. Each reference has the full syntax surface plus 3-5 copy-pasteable examples.

4. **If unsure**, default to `graph TD` with subgraphs — it covers the most ground.

5. After writing the block, mentally re-check the first non-comment, non-blank line — is it one of the 6 supported keywords?

## References

| File | When to load |
|---|---|
| `references/flowchart.md` | Writing any `graph` / `flowchart` — most common. Covers 12 node shapes, 5 edge styles, subgraphs, classDef / `:::` / `style`, `linkStyle`, real-world examples. |
| `references/state.md` | Writing `stateDiagram-v2` — start/end pseudostates, composite states, direction override, CJK state names. |
| `references/sequence.md` | Writing `sequenceDiagram` — participants/actors, 4 arrow types, activation `+`/`-`, 7 control blocks (`loop`/`alt`/`opt`/`par`/`critical`/`break`/`rect`), notes, OAuth-style real-world example. |
| `references/class.md` | Writing `classDiagram` — visibility `+`/`-`/`#`/`~`, generics `~T~`, static `$`, abstract `*`, 6 relationship types, `<<interface>>`/`<<abstract>>`/`<<enumeration>>` annotations, namespaces, Observer/MVC examples. |
| `references/er.md` | Writing `erDiagram` — attributes with PK/FK/UK, crow's-foot cardinality, identifying vs non-identifying, e-commerce/blog schema examples. |
| `references/xychart.md` | Writing `xychart-beta` — bar/line/combined, horizontal, multi-series, numeric x-axis, burndown/MAU examples. |
| `references/swaps.md` | The user asked for an unsupported type, or a diagram is broken. Contains the full swap table, common pitfalls, and a diagnostic checklist. |

**Source of truth for syntax:** `docs/beautiful-mermaid-examples.md` in the repo (70+ examples). Load it only if a specific syntax detail isn't in the per-type reference.

## If the user reports a broken diagram

When a Mermaid block fails to render, the user sees **raw source in a `<pre>` block + a red error banner below it** with the parser's technical message (something like `Unexpected token 'group' at line 2` or `Failed to render Mermaid diagram — ...`). There is no toast or modal — the failure is silent and only visible inline.

To diagnose:

1. **Check the first non-comment, non-empty line.** Must be one of the 6 supported types. If not, swap per `references/swaps.md`. **This is the most common cause by far** — most "broken diagram" reports are actually unsupported-type reports.
2. Check node IDs — any non-ASCII? Move to labels.
3. Check `subgraph` / `state` / `class` / `loop` / `alt` blocks — is each closed with `end` (or `}` for class)?
4. Check class annotations — on their own line above the class name?
5. Check multi-line labels — used `\n` instead of `<br/>`?
6. If still stuck, parse it directly:
   ```bash
   node -e "const {parseMermaid} = require('beautiful-mermaid'); try { parseMermaid('<paste>') } catch (e) { console.error(e.message) }"
   ```

**Do not tell the user to "check the version" or "wait for a fix"** — the library will not gain new diagram types on its own. The only fix is for you to rewrite the block using a supported type.
