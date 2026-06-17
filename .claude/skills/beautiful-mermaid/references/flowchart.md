# Flowchart reference (`graph` / `flowchart`)

**Load this when:** writing or reviewing a flowchart / decision tree / architecture / process flow / state-diagram-style diagram. This is the most common type — start here unless the user explicitly asked for sequence/class/ER/xychart.

> Beautiful-mermaid uses one parser for `graph`, `flowchart`, and `stateDiagram-v2`. State-diagram-specific features (pseudostates, composite states) are in `state.md`. Everything below works in all three.

## Directions

`TD`/`TB` top-down, `LR` left-right, `BT` bottom-top, `RL` right-left.

```mermaid
graph LR
  A[Input] --> B[Transform] --> C[Output]
```

## All 12 node shapes

| Syntax | Shape |
|---|---|
| `[text]` | Rectangle |
| `(text)` | Rounded |
| `{text}` | Diamond (decision) |
| `([text])` | Stadium (pill) |
| `((text))` | Circle |
| `[[text]]` | Subroutine (double-bordered) |
| `(((text)))` | Double circle |
| `{{text}}` | Hexagon |
| `[(text)]` | Cylinder (database) |
| `>text]` | Asymmetric / flag |
| `[/text\]` | Trapezoid (wider bottom) |
| `[\text/]` | Inverse trapezoid (wider top) |
| `[*]` | State start/end pseudostate |

```mermaid
graph LR
  A[Rectangle] --> B(Rounded)
  B --> C{Diamond}
  C --> D([Stadium])
  D --> E((Circle))
  E --> F[[Subroutine]]
  F --> G(((Double Circle)))
  G --> H{{Hexagon}}
  H --> I[(Database)]
  I --> J>Flag]
  J --> K[/Trapezoid\]
  K --> L[\Inverse Trap/]
```

## Edges

| Syntax | Style |
|---|---|
| `-->` | Solid arrow |
| `-.->` | Dotted arrow |
| `==>` | Thick arrow |
| `---` | Solid line, no arrowhead |
| `-.-` | Dotted line, no arrowhead |
| `===` | Thick line, no arrowhead |
| `-->|label\|` | Pipe-embedded label |
| `-- label -->` | Text-embedded label |
| `<-->`, `<-.->`, `<==>` | Bidirectional |

```mermaid
graph TD
  A[Source] -->|solid| B[Target 1]
  A -.->|dotted| C[Target 2]
  A ==>|thick| D[Target 3]
  A ---|related| E[Node 2]
  E -.- F[Node 3]
  F === G[Node 4]
  H[Client] <-->|sync| I[Server]
```

## Chaining & parallel edges

```mermaid
graph LR
  A[Step 1] --> B[Step 2] --> C[Step 3] --> D[Step 4] --> E[Step 5]
```

```mermaid
graph TD
  A[Input] & B[Config] --> C[Processor]
  C --> D[Output] & E[Log]
```

## Subgraphs (nestable, with direction override)

```mermaid
graph TD
  subgraph Cloud
    subgraph us-east [US East Region]
      A[Web Server] --> B[App Server]
    end
    subgraph us-west [US West Region]
      C[Web Server] --> D[App Server]
    end
  end
  E[Load Balancer] --> A
  E --> C
```

```mermaid
graph TD
  subgraph pipeline [Processing Pipeline]
    direction LR
    A[Input] --> B[Parse] --> C[Transform] --> D[Output]
  end
  E[Source] --> A
  D --> F[Sink]
```

> Use the bracket form `subgraph id [Label]` — **not** the curly-brace form `subgraph "Label" { ... }` (not supported). Always close with `end`.

## Styling: classDef / `:::` shorthand / `style` inline

```mermaid
graph TD
  A[Normal]:::default --> B[Highlighted]:::highlight --> C[Error]:::error
  classDef default fill:#f4f4f5,stroke:#a1a1aa
  classDef highlight fill:#fbbf24,stroke:#d97706
  classDef error fill:#ef4444,stroke:#dc2626
```

```mermaid
graph TD
  A[Default] --> B[Custom Colors] --> C[Another Custom]
  style B fill:#3b82f6,stroke:#1d4ed8,color:#ffffff
  style C fill:#10b981,stroke:#059669
```

## `linkStyle` — per-edge color and width

Indices are 0-based. `default` applies to every edge. Index-specific styles override default. **Supported properties: `stroke`, `stroke-width` only.**

```mermaid
graph TD
  A[Start] --> B{Decision}
  B -->|Yes| C[Accept]
  B -->|No| D[Reject]
  C --> E[Done]
  D --> E
  linkStyle 0 stroke:#7aa2f7,stroke-width:3px
  linkStyle 1 stroke:#9ece6a,stroke-width:2px
  linkStyle default stroke:#565f89
```

## Real-world example: microservices architecture

```mermaid
graph LR
  subgraph clients [Client Layer]
    A([Web App]) --> B[API Gateway]
    C([Mobile App]) --> B
  end
  subgraph services [Service Layer]
    B --> D[Auth Service]
    B --> E[User Service]
    B --> F[Order Service]
  end
  subgraph data [Data Layer]
    D --> G[(Auth DB)]
    E --> H[(User DB)]
    F --> I[(Order DB)]
  end
```

## Don'ts

- Node IDs must be ASCII. Put Chinese/emoji in the label: `A["用户"]` not `A[用户]`
- No `init` directive at the start of flowcharts (not supported)
- No `click A "https://..."` directives (render as raw text)
- No curly-brace form: `subgraph "Label" { ... }` is invalid. Use `subgraph id [Label] ... end`
- Multi-line labels don't work well — use `<br/>` to break lines inside a label

## More

For 40+ additional flowchart examples (CI/CD pipelines, decision trees, git branches, etc.) see `docs/beautiful-mermaid-examples.md` in the repo.
