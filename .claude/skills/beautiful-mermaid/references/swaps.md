# Swaps & unsupported types

**Load this when:** the user asks for a diagram type beautiful-mermaid doesn't support, or reports a Mermaid block that fails to render. This is the decision guide for "what to do when the natural type doesn't work".

## The hard rule

**pi-web uses `beautiful-mermaid` (not mermaid 11).** It supports 6 types:

| Supported | Keyword |
|---|---|
| Flowchart | `graph`, `flowchart` |
| State diagram | `stateDiagram-v2` |
| Sequence diagram | `sequenceDiagram` |
| Class diagram | `classDiagram` |
| ER diagram | `erDiagram` |
| XY chart | `xychart-beta` |

**Everything else fails.** When an unsupported type is used, pi-web shows the raw source in a `<pre>` block plus a red error banner below it with the parser's technical message (e.g. `Failed to render Mermaid diagram — Unexpected token 'group' at line 2`). The error is only visible inline — there's no toast or modal.

## Unsupported → swap table

When the user asks for one of these, swap to the closest supported analog and **tell the user explicitly** what you did.

| User asks for | Use instead | Notes |
|---|---|---|
| C4 (Context / Container / Component / Dynamic) | `flowchart` with nested `subgraphs` labeled `System`, `Container: ...`, etc. | Faithful swap — subgraphs give the same hierarchical grouping. |
| Mindmap | `flowchart TD` with `subgraphs` for branches | Faithful swap — hierarchy is preserved. |
| Architecture diagram | `flowchart` with nested `subgraphs` | Faithful swap. |
| Pie chart | `xychart-beta` with a single `bar` series | Faithful swap — just rectangular instead of wedge. |
| Git graph | `flowchart LR` with branch labels on edges | Mostly faithful. The "parent commit is to the left of child" convention has to be hand-drawn with edge labels. |
| Timeline | `flowchart LR` with date/category labels on x-axis-style nodes | Faithful swap. |
| Journey | `sequenceDiagram` with `actor` and `Note over` blocks | Faithful swap. |
| Quadrant chart | `flowchart` with two diamond decisions splitting the plane into 4 quadrants | Faithful swap. |
| Requirement diagram | `classDiagram` with attributes and relationships | Faithful swap. |
| Block diagram | `flowchart` with `subgraphs` | Faithful swap. |
| Sankey | `flowchart LR` with weighted edge labels | **Lossy** — there is no way to represent flow *width* in beautiful-mermaid. State this clearly and suggest `flowchart` only for very small diagrams. |
| Radar | `xychart-beta line` | **Lossy** — there is no polar coordinate system. The "spider web" shape can't be represented. State this clearly and suggest a bar chart of the same metrics. |
| Packet / C4 packet | `flowchart` with `subgraphs` | Faithful swap. |

**Always state the swap** so the user can correct you: "Used a flowchart with subgraphs because beautiful-mermaid doesn't support C4. Let me know if you wanted something different."

## How to phrase the swap

Good phrasing pattern (bilingual):

- **Chinese**: "beautiful-mermaid 不支持 C4,我换成了 `flowchart` + 嵌套 `subgraph` 来近似 C4 的层级结构。如下:"
- **English**: "C4 isn't supported by beautiful-mermaid, so I swapped to `flowchart` with nested `subgraphs` to approximate the C4 hierarchy:"

State the swap **before** the code block, not after, so the user sees the explanation first.

## Common pitfalls that LOOK valid but don't work

These are syntax errors that the parser accepts but the renderer chokes on. Avoid them.

### Node IDs must be ASCII

```mermaid
A[用户]  %% WRONG — Chinese in node ID, parser may fail
A["用户"]  %% RIGHT — Chinese goes in the label
```

### Subgraph labels

```mermaid
subgraph "Label with spaces"  %% WRONG — quoted form
subgraph id [Label with spaces]  %% RIGHT — bracket form
```

### State names with spaces in `stateDiagram-v2`

```mermaid
state "My State"  %% WRONG — not supported
state MyState     %% RIGHT — no spaces, or use a flowchart with subgraphs
```

### Generic type syntax

```mermaid
class Box<T>  %% WRONG in markdown contexts
class Box~T~  %% RIGHT — use ~T~ for <T>
```

### Class annotations

```mermaid
class Foo <<interface>> { ... }  %% WRONG — annotation on same line
class Foo {
  <<interface>>                  %% RIGHT — own line above the body
  +method() void
}
```

### Multi-line labels

```mermaid
A[Line 1\nLine 2]  %% WRONG — \n doesn't work in node labels
A["Line 1<br/>Line 2"]  %% RIGHT — use HTML <br/>
```

## Diagnosing a broken diagram

When a Mermaid block fails, the user sees:
- The **raw source in a `<pre>` block** (because `svg === null`)
- A **red error banner** directly below: `Failed to render Mermaid diagram — <parser message>`

Common error messages you'll see in the banner:
- `Unexpected token 'group'` — most likely an `architecture-beta` or C4 block (these have `group` as a top-level keyword)
- `Unexpected token 'C4Container'` — C4 diagram
- `Unknown diagram type` — unusual case
- `Expected end of block` / `Unexpected EOF` — unclosed `subgraph` / `state` / `loop` / `alt` / `class { ... }` block

To diagnose:

1. **Check the first non-comment, non-empty line.** Is it one of the 6 supported types? If not, swap per the table above. **This is the cause in the vast majority of "broken diagram" reports** — most are actually unsupported-type reports.
2. **Check node IDs.** Any non-ASCII characters? Move them to labels.
3. **Check subgraph / state / class / loop / alt blocks.** Is each one closed with `end` (or `}` for class)? Unclosed blocks are the #1 syntax-error cause among supported types.
4. **Check the class annotations.** Are they on their own line above the class name?
5. **Check the multi-line labels.** Did you use `\n` instead of `<br/>`?
6. **If all else fails**, run the source through the parser directly:
   ```bash
   node -e "const {parseMermaid} = require('beautiful-mermaid'); try { parseMermaid('<paste source here>') } catch (e) { console.error(e.message) }"
   ```

**Do not tell the user to "check the Mermaid version" or "wait for a library update".** beautiful-mermaid's supported-type list is hard-coded in its TypeScript signature and will not grow without a library release. The only fix is for you to rewrite the block using a supported type.
