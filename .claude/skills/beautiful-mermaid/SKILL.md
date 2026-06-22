---
name: beautiful-mermaid
description: "Use this skill whenever you are about to write a ```mermaid code block in pi-web. beautiful-mermaid (the renderer pi-web uses, in place of mermaid 11) only supports 6 diagram types: `graph`/`flowchart`, `stateDiagram-v2`, `sequenceDiagram`, `classDiagram`, `erDiagram`, and `xychart-beta`. All other Mermaid types (`gitGraph`, `mindmap`, `timeline`, `sankey-beta`, `pie`, `quadrantChart`, `block-beta`, `C4Context`/`C4Container`/`C4Component`/`C4Dynamic`/`C4Deployment`, `packet`/`packet-beta`, `architecture-beta`, `journey`, `requirementDiagram`, `radar-beta`, `gantt`, `kanban`) fail to render. Trigger when the user asks for any diagram/chart/visualization/schema, 流程图/时序图/类图/ER图/状态图/架构图, or reports a Mermaid block isn't rendering. When the natural diagram type is unsupported, swap to the closest supported type and tell the user explicitly (e.g., \"Used a flowchart with subgraphs because beautiful-mermaid doesn't support C4.\")."
---

# beautiful-mermaid skill

## The one thing you must remember

**pi-web renders Mermaid with `beautiful-mermaid`, not mermaid 11.** It supports **6 diagram types**, hard-coded by `detectDiagramType()` in `third/beautiful-mermaid/src/index.ts:54`. Anything else falls through to `flowchart`, gets parsed as a flowchart, and throws on the first unfamiliar keyword.

| Supported | Not supported (will fail to render) |
|---|---|
| `graph` / `flowchart` (incl. `stateDiagram-v2`) | `gitGraph`, `mindmap`, `timeline`, `gantt`, `kanban` |
| `sequenceDiagram` | `pie`, `quadrantChart`, `block-beta`, `radar-beta` |
| `classDiagram` | `sankey-beta`, `journey`, `requirementDiagram` |
| `erDiagram` | `C4Context`/`C4Container`/`C4Component`/`C4Dynamic`/`C4Deployment` |
| `xychart-beta` | `packet`/`packet-beta`, `architecture-beta` |

**"Mermaid syntax" ≠ "beautiful-mermaid syntax".** The Mermaid docs describe 20+ diagram types; beautiful-mermaid implements 6. Many syntax details inside the supported types are also unsupported (e.g. `classDef` only honors `fill`/`stroke`/`stroke-width`/`color` — everything else is silently ignored; `linkStyle` only honors `stroke`/`stroke-width`).

The full list — diagram types AND intra-type syntax — is in `references/swaps.md`. Load that file before writing any Mermaid block whose syntax you're not 100% sure about.

## When to trigger

You MUST consult this skill before emitting a ```mermaid block:

- User asks for a "diagram", "chart", "graph", "schema", 流程图/时序图/类图/ER图/状态图/架构图, etc.
- You're about to visualize an architecture, workflow, data model, state machine, sequence of calls, class hierarchy, database schema, or numeric trend.
- The user pastes a Mermaid block and asks you to fix it, or reports "the diagram doesn't show up".

If unsure whether the user wants a Mermaid block, **err on the side of triggering** — checking is cheap.

## Decision flow

1. **Identify the natural type from the user's intent.** Defaults:
   - Process / control flow / decision tree → `graph TD` (`references/flowchart.md`)
   - Time-ordered interactions → `sequenceDiagram` (`references/sequence.md`)
   - Object-oriented structure / design pattern → `classDiagram` (`references/class.md`)
   - Database schema → `erDiagram` (`references/er.md`)
   - State machine → `stateDiagram-v2` (`references/state.md`)
   - Numeric chart → `xychart-beta` (`references/xychart.md`)

2. **Is the natural type in the not-supported column?** If yes, swap per `references/swaps.md` and tell the user what you did.

3. **Load the matching reference** for the chosen type. Each reference has the full syntax surface plus 3-5 copy-pasteable examples.

4. **If unsure**, default to `graph TD` with subgraphs — it covers the most ground.

5. After writing the block, re-check the first non-comment, non-blank line — is it one of the 6 supported keywords?

## References

| File | When to load |
|---|---|
| `references/swaps.md` | **Always** — unsupported diagram types, intra-type syntax, pitfalls, and the diagnostic checklist. Start here. |
| `references/flowchart.md` | Writing `graph` / `flowchart` — most common. Covers 12 node shapes, 5 edge styles, subgraphs, classDef/`:::`/`style`, `linkStyle`. |
| `references/state.md` | Writing `stateDiagram-v2` — start/end pseudostates, composite states, direction override. |
| `references/sequence.md` | Writing `sequenceDiagram` — participants/actors, 4 arrow types, activation `+`/`-`, 7 control blocks, notes. |
| `references/class.md` | Writing `classDiagram` — visibility `+`/`-`/`#`/`~`, generics `~T~`, static `$`, abstract `*`, 6 relationship types. |
| `references/er.md` | Writing `erDiagram` — attributes with PK/FK/UK, crow's-foot cardinality, identifying vs non-identifying. |
| `references/xychart.md` | Writing `xychart-beta` — bar/line/combined, horizontal, multi-series, numeric x-axis. |

**Source of truth for syntax:** the per-type parsers under `third/beautiful-mermaid/src/{,class/,er/,sequence/,xychart/}/parser.ts`. When a syntax detail is ambiguous, read the regex directly — the docs only summarize what's parsed.

## If the user reports a broken diagram

When a Mermaid block fails to render, the user sees **raw source in a `<pre>` block + a red error banner** with the parser's technical message (e.g. `Failed to render Mermaid diagram — Unexpected token 'group' at line 2`). There is no toast — the failure is silent and only visible inline.

Follow the diagnostic checklist at the bottom of `references/swaps.md`. **Do not tell the user to "check the Mermaid version" or "wait for a fix"** — the library will not gain new diagram types on its own. The only fix is to rewrite the block using a supported type.