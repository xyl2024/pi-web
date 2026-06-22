# Sequence diagram reference (`sequenceDiagram`)

**Load this when:** the user asks for 时序图 / sequence diagram / API call flow / actor interaction / OAuth flow / request-response trace.

## Participants and actors

- `participant` renders as a **box**
- `actor` renders as a **stick figure**
- Use `participant ID as Label` (or `actor ID as Label`) to alias compact IDs into readable labels

```mermaid
sequenceDiagram
  actor U as User
  participant S as System
  participant DB as Database
  U->>S: Click button
  S->>DB: Query
  DB-->>S: Results
  S-->>U: Display
```

## Arrow types

| Syntax | Effect |
|---|---|
| `->>` | Solid line, filled arrowhead (sync call) |
| `-->>` | Dashed line, filled arrowhead (return) |
| `-)` | Solid line, open arrowhead (async fire-and-forget) |
| `--)` | Dashed line, open arrowhead |
| `-x` | Solid line, cross arrowhead (invalidation) |
| `--x` | Dashed line, cross arrowhead |

```mermaid
sequenceDiagram
  A->>B: Solid arrow (sync)
  B-->>A: Dashed arrow (return)
  A-)B: Open arrow (async)
  B--)A: Open dashed arrow
  A--xB: Cross (cancel)
```

## Activation (`+` / `-`)

Append `+` after the target to start an activation box, `-` to end it. Pair `+`/`-` on the actor that activates/deactivates.

```mermaid
sequenceDiagram
  participant C as Client
  participant S as Server
  C->>+S: Request
  S->>+S: Process
  S->>-S: Done
  S-->>-C: Response
```

## Self-messages (loop arrows)

Same actor on both sides → renders as a small loop arrow.

```mermaid
sequenceDiagram
  participant S as Server
  S->>S: Internal process
  S->>S: Validate
  S-->>S: Log
```

## Notes

`Note left of A: ...`, `Note right of B: ...`, `Note over A,B: ...` (over one or more actors).

```mermaid
sequenceDiagram
  participant A as Alice
  participant B as Bob
  Note left of A: Alice prepares
  A->>B: Hello
  Note right of B: Bob thinks
  B-->>A: Reply
  Note over A,B: Conversation complete
```

## Control blocks

| Keyword | Purpose | Divider |
|---|---|---|
| `loop Label … end` | Repeated exchange | — |
| `alt Label … else Label … end` | If / else-if branches | `else` |
| `opt Label … end` | Optional, executes if condition holds | — |
| `par Label … and Label … end` | Parallel sections | `and` |
| `critical Label … end` | Atomic section | — |
| `break Label … end` | Break-out exception path | — |
| `rect rgb(N) … end` | Highlight a region | — |

```mermaid
sequenceDiagram
  participant C as Client
  participant S as Server
  C->>S: Connect
  loop Every 30s
    C->>S: Heartbeat
    S-->>C: Ack
  end
  C->>S: Disconnect
```

```mermaid
sequenceDiagram
  participant C as Client
  participant S as Server
  C->>S: Login
  alt Valid credentials
    S-->>C: 200 OK
  else Invalid
    S-->>C: 401 Unauthorized
  else Account locked
    S-->>C: 403 Forbidden
  end
```

```mermaid
sequenceDiagram
  participant C as Client
  participant A as AuthService
  participant U as UserService
  participant O as OrderService
  C->>A: Authenticate
  par Fetch user data
    A->>U: Get profile
  and Fetch orders
    A->>O: Get orders
  end
  A-->>C: Combined response
```

## Real-world example: OAuth 2.0 authorization-code flow

```mermaid
sequenceDiagram
  actor U as User
  participant App as Client App
  participant Auth as Auth Server
  participant API as Resource API
  U->>App: Click Login
  App->>Auth: Authorization request
  Auth->>U: Login page
  U->>Auth: Credentials
  Auth-->>App: Authorization code
  App->>Auth: Exchange code for token
  Auth-->>App: Access token
  App->>API: Request + token
  API-->>App: Protected resource
```

## Don'ts

- Activation `+`/`-` must be appended to a message arrow's target/source — not on its own line
- `loop`/`alt`/`par`/etc. must be closed with `end`. Unclosed blocks are the #1 parse error
- `else` and `and` are **only** valid inside `alt` and `par` respectively — don't use standalone
- Notes can't be inside blocks in some parser variants — keep notes between messages, not inside `loop`/`alt` (or test before relying on it)

## More

For more sequence-diagram examples (database transactions, microservice orchestration, complex self-message flows) see `docs/beautiful-mermaid-examples.md` in the repo.
