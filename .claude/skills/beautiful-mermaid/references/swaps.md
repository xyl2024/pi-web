# Swaps & unsupported syntax

**Load this when:** the user asks for a diagram type beautiful-mermaid doesn't support, reports a Mermaid block that fails to render, or you're writing a block whose syntax you're not 100% sure about.

## The hard rule

**pi-web uses `beautiful-mermaid` (not mermaid 11).** It supports 6 types — hard-coded in `beautiful-mermaid/src/index.ts`:

| Supported | Keyword |
|---|---|
| Flowchart | `graph`, `flowchart` |
| State diagram | `stateDiagram-v2` (parsed by the same code path as flowchart) |
| Sequence diagram | `sequenceDiagram` |
| Class diagram | `classDiagram` |
| ER diagram | `erDiagram` |
| XY chart | `xychart-beta` (or `xychart`) |

Everything else falls through to `flowchart`, gets parsed as a flowchart, and throws on the first unfamiliar keyword. When a Mermaid block fails to render, the user sees **the raw source in a `<pre>` block + a red error banner** with the parser's technical message (e.g. `Unexpected token 'group' at line 2`). There is no toast — failures are silent and only visible inline.

---

## 1. Unsupported diagram types → swap table

When the user asks for one of these, swap to the closest supported analog and **tell the user explicitly** what you did.

| User asks for | Use instead | Notes |
|---|---|---|
| `C4Context` / `C4Container` / `C4Component` / `C4Dynamic` / `C4Deployment` | `flowchart` with nested `subgraphs` labeled `System`, `Container: ...`, etc. | Faithful — subgraphs give the same hierarchical grouping. |
| `mindmap` | `flowchart TD` with `subgraphs` for branches | Faithful — hierarchy is preserved. |
| `architecture-beta` / `block-beta` | `flowchart` with nested `subgraphs` | Faithful. |
| `gitGraph` | `flowchart LR` with branch labels on edges | Mostly faithful. The "parent commit left of child" convention has to be hand-drawn with edge labels. |
| `timeline` | `flowchart LR` with date/category labels on x-axis-style nodes | Faithful. |
| `journey` | `sequenceDiagram` with `actor` and `Note over` blocks | Faithful. |
| `requirementDiagram` | `classDiagram` with attributes and relationships | Faithful. |
| `gantt` | `xychart-beta` with `bar` series, one bar per task | Lossy — no dependencies, no progress %, no date axis. State this clearly. |
| `pie` | `xychart-beta` with a single `bar` series | Faithful — rectangular instead of wedge. |
| `quadrantChart` | `flowchart` with two diamond decisions splitting the plane into 4 quadrants | Faithful. |
| `sankey-beta` | `flowchart LR` with weighted edge labels | **Lossy** — there is no way to represent flow *width*. State this clearly; suggest `flowchart` only for very small diagrams. |
| `radar-beta` | `xychart-beta` with `bar` (or stacked `bar`) per axis | **Lossy** — no polar coordinate system; the "spider web" can't be represented. State this clearly. |
| `packet` / `packet-beta` | `flowchart` with `subgraphs` | Faithful. |
| `kanban` | `flowchart` with parallel columns of `subgraphs` | Faithful — one column per kanban column, cards as nodes. |

### How to phrase the swap

State the swap **before** the code block so the user sees the explanation first.

- **Chinese**: "beautiful-mermaid 不支持 C4,我换成了 `flowchart` + 嵌套 `subgraph` 来近似 C4 的层级结构。如下:"
- **English**: "C4 isn't supported by beautiful-mermaid, so I swapped to `flowchart` with nested `subgraphs` to approximate the C4 hierarchy:"

---

## 2. Unsupported syntax INSIDE supported types

These are syntax patterns that **look valid Mermaid** but beautiful-mermaid parses, ignores, or breaks on. Avoid them.

### Universal (all diagram types)

| Syntax | Status |
|---|---|
| `%%{init: {...}}%%` frontmatter / theme config | **Not parsed** — passed through as a comment line and silently dropped. There is no runtime config. |
| `click NODE "url" "tooltip"` interactivity | **Not parsed** — emitted as raw text in the diagram, breaks the layout. |
| `init` directive at the top of any block | **Not parsed.** |
| Node IDs containing non-ASCII (Chinese, emoji, spaces) | **Broken in flowcharts** — the parser regex is `[\w-]+`, which doesn't match unicode. Put non-ASCII in the label only (`A["用户"]`, not `A[用户]`). State diagrams are the exception — `[\w\p{L}]+` allows unicode in IDs. |
| `classDef` properties other than `fill`, `stroke`, `stroke-width`, `color` | **Silently ignored** by the renderer. `font-size`, `font-weight`, `font-family`, `opacity`, etc. are parsed into the map but never read. |
| `linkStyle` properties other than `stroke`, `stroke-width` | **Silently ignored.** |
| HTML tags inside labels | `<br>`/`<br/>`/`<b>`/`<i>`/`<u>`/`<s>`/`<strong>`/`<em>`/`<del>` work. `<sub>`/`<sup>`/`<small>`/`<mark>` are stripped. Anything else (`<a>`, `<img>`, `<table>`) is escaped and rendered as literal text. |
| Markdown `**bold**`, `*italic*`, `~~strike~~` inside labels | **Work** — converted to `<b>`/`<i>`/`<s>` tspan attributes. But note `<T>` generics are ambiguous — see class diagrams below. |

### Flowchart / graph only

| Syntax | Status |
|---|---|
| `subgraph "Label" { ... }` (curly-brace form) | **Not parsed.** Use `subgraph id [Label] ... end`. |
| `subgraph id { ... }` (no label) | **Not parsed.** Always use the bracket form `subgraph id [Label]`. |
| `state "Long Name" { ... }` (composite state with label, no `as`) | **Not parsed** — the composite-state regex requires the `as` form: `state "Long Name" as Foo { ... }`. |
| `A@{ shape: rect }` / `@{ ... }` styling | **Not parsed.** |
| Standalone `end` at the wrong indentation | **Works structurally** but no special handling — indentation is cosmetic only. |

### Sequence diagram only

| Syntax | Status |
|---|---|
| `box` / `box end` | **Not parsed** — drops the keyword and lines until `box end`. Use `Note over` for grouping. |
| `Properties:` block (`Properties: X=val`) | **Not parsed.** |
| `autonumber` directive | **Not parsed.** |
| `hscale` / `wrap` / `width` directives | **Not parsed.** |
| Standalone `activate A` / `deactivate A` lines | **Silently skipped** by the parser. Use `+`/`-` on the target of a message arrow. |
| Multi-line messages (`A->>B: line 1<br/>line 2`) | **Works** — `<br/>` is normalized to a newline. |

### Class diagram only

| Syntax | Status |
|---|---|
| `class Foo <<interface>> { ... }` (annotation on same line as the class declaration) | **Partial** — only the single-line inline form `class Foo { <<interface>> }` works; the multi-line form needs annotation on its own line. |
| Generics via angle brackets `class Box<T>` | **Broken** — `<T>` looks like HTML and is escaped. Use `~T~` instead. |
| `<T, U>` multiple generics | **Probably broken** — angle brackets are HTML. Use `~T,U~` and verify. |
| `interface`, `enum`, `abstract` keywords inside the body | **Not parsed.** Use the `<<interface>>`/`<<enumeration>>`/`<<abstract>>` annotations and the `$` (static) / `*` (abstract) member prefixes. |

### ER diagram only

| Syntax | Status |
|---|---|
| `namespace` blocks | **Not parsed.** Entities must be flat at the top level. |
| Cardinality glyphs with spaces (`|| -- o{` instead of `||--o{`) | **Not parsed** — the regex `[\|o}{]+(?:--|\.\.)[\|o}{]+` requires tight gluing. |
| `classDef` styling on entities | **Not supported** by the ER renderer. |
| `style` directives | **Not supported** by the ER renderer. |

### XY chart only

| Syntax | Status |
|---|---|
| `pie` segments | **Not parsed** — pie is an entirely separate Mermaid type. |
| Stacked bars (single x-position, multiple stacked values) | **Not supported** — multiple `bar` series render side-by-side, not stacked. |
| Categorical y-axis | **Not supported** — y-axis is always numeric. |
| Log scale | **Not supported** — linear only. |
| Error bars | **Not supported.** |
| Date/time axis | **Not supported** — categories must be labels; numeric x-axis is plain numbers. |
| Pie / donut / polar | **Not supported** — `xychart-beta` is bar/line/combined only. |

### State diagram only

| Syntax | Status |
|---|---|
| `classDef` styling | **Parsed** by the state parser but **ignored** by the state renderer. If you need styled states, switch to `graph TD`. |
| `linkStyle` | **Parsed** but **ignored** by the state renderer. |
| `<<choice>>` / fork / join pseudostates | **Not parsed** — only `[*]` start/end pseudostates are supported. |
| Concurrent regions | **Not parsed.** |
| `note left of X : ...` | **Not parsed** in state diagrams. Use a separate flowchart node. |

---

## 3. Common pitfalls that LOOK valid but break

These are syntax errors that the parser accepts but the renderer chokes on.

### Subgraph labels

```mermaid
subgraph "Label with spaces"  %% WRONG — quoted form, parser tries to treat it as composite state
subgraph id [Label with spaces]  %% RIGHT — bracket form
```

### Generic type syntax

```mermaid
class Box<T>           %% WRONG in markdown contexts — <T> looks like HTML
class Box~T~           %% RIGHT — ~T~ for <T>
```

### Class annotations

```mermaid
class Foo <<interface>> { ... }   %% WRONG — annotation on same line as class header
class Foo {                        %% RIGHT — annotation on its own line
  <<interface>>
  +method() void
}
```

### Multi-line labels

```mermaid
A[Line 1\nLine 2]           %% WRONG — literal \n renders as backslash-n
A["Line 1<br/>Line 2"]     %% RIGHT — use HTML <br/>
```

### Composite state with label

```mermaid
state "Processing" { ... }               %% WRONG — composite state regex requires `as`
state "Processing" as Processing { ... }  %% RIGHT
```

---

## 4. Diagnostic checklist for broken diagrams

When a Mermaid block fails, the user sees the raw source + a red error banner. Walk this list top-to-bottom — the first match is almost always the cause.

1. **Check the first non-comment, non-empty line.** Must be one of the 6 supported types. If not, swap per the table above. **This is the cause in the vast majority of "broken diagram" reports** — most are actually unsupported-type reports.
2. **Check for `init`/`%%{...}%%`/`click`/frontmatter.** Strip them — none are parsed.
3. **Check node IDs.** Any non-ASCII characters in a flowchart? Move them to labels. (State diagrams are an exception.)
4. **Check subgraph / state / class / loop / alt blocks.** Is each closed with `end` (or `}` for class / namespace / state composite)? Unclosed blocks are the #1 syntax-error cause among supported types.
5. **Check class annotations.** Are they on their own line above the class name (not on the `class Foo ... {` line)?
6. **Check multi-line labels.** Did you use `\n` instead of `<br/>`?
7. **Check generic types in class diagrams.** Are you using `<T>` instead of `~T~`?
8. **If still stuck**, parse the source directly to see the exact error:
   ```bash
   node -e "const {parseMermaid} = require('beautiful-mermaid'); try { parseMermaid('<paste source here>') } catch (e) { console.error(e.message) }"
   ```
9. **If all else fails**, run the source through the parser source directly:
   - `third/beautiful-mermaid/src/parser.ts` — flowcharts and state diagrams
   - `third/beautiful-mermaid/src/sequence/parser.ts` — sequence
   - `third/beautiful-mermaid/src/class/parser.ts` — class
   - `third/beautiful-mermaid/src/er/parser.ts` — ER
   - `third/beautiful-mermaid/src/xychart/parser.ts` — XY chart

**Do not tell the user to "check the Mermaid version" or "wait for a library update".** beautiful-mermaid's supported-type list is hard-coded in its TypeScript signature and will not grow without a library release. The only fix is to rewrite the block using a supported type.