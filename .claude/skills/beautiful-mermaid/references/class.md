# Class diagram reference (`classDiagram`)

**Load this when:** the user asks for 类图 / class diagram / UML / object model / design pattern visualization / OOP hierarchy.

## Class members

- **Visibility markers** prefix the name: `+` public, `-` private, `#` protected, `~` package
- **Static**: prefix the name with `$` (e.g. `$count()`)
- **Abstract**: prefix the name with `*` (e.g. `*draw()`)
- **Method parameters** go inside the parentheses
- **Generics**: use `~T~` for `<T>` (e.g. `List~Observer~ items`)

```mermaid
classDiagram
  class User {
    +String name
    -String password
    #int internalId
    ~String packageField
    +login() bool
    -hashPassword() String
    #validate() void
    ~notify() void
  }
```

## Class annotations

`<<interface>>`, `<<abstract>>`, `<<enumeration>>`, `<<service>>` etc. — place on the line **above** the class name inside the block.

```mermaid
classDiagram
  class Serializable {
    <<interface>>
    +serialize() String
    +deserialize(data) void
  }
```

```mermaid
classDiagram
  class Shape {
    <<abstract>>
    +String color
    +area() double
    +draw() void
  }
```

```mermaid
classDiagram
  class Status {
    <<enumeration>>
    ACTIVE
    INACTIVE
    PENDING
    DELETED
  }
```

## Relationship types (all 6)

| Syntax | Type | Marker |
|---|---|---|
| `<\|--` | Inheritance | Hollow triangle |
| `*--` | Composition | Filled diamond |
| `o--` | Aggregation | Hollow diamond |
| `-->` | Association | Open arrow |
| `..>` | Dependency | Dashed line, open arrow |
| `..\|>` | Realization | Dashed line, hollow triangle |

Markers can go on either side (`<\|--` and `--\|>` are both inheritance). Append `: Label` to add a relationship label.

```mermaid
classDiagram
  class Animal {
    +String name
    +eat() void
  }
  class Dog {
    +String breed
    +bark() void
  }
  Animal <|-- Dog
```

```mermaid
classDiagram
  class Service {
    +process() void
  }
  class Repository {
    +find() Object
  }
  Service ..> Repository
```

**All six in one diagram for comparison:**

```mermaid
classDiagram
  A <|-- B : inheritance
  C *-- D : composition
  E o-- F : aggregation
  G --> H : association
  I ..> J : dependency
  K ..|> L : realization
```

## Namespaces

`namespace Name { class A { ... } }` groups classes visually.

```mermaid
classDiagram
  namespace App {
    class Main
    class Helper
  }
  namespace Lib {
    class Engine
  }
  Main --> Helper
  Main --> Engine
```

## Real-world example: Observer design pattern

```mermaid
classDiagram
  class Subject {
    <<interface>>
    +attach(Observer) void
    +detach(Observer) void
    +notify() void
  }
  class Observer {
    <<interface>>
    +update() void
  }
  class EventEmitter {
    -List~Observer~ observers
    +attach(Observer) void
    +detach(Observer) void
    +notify() void
  }
  class Logger {
    +update() void
  }
  class Alerter {
    +update() void
  }
  Subject <|.. EventEmitter
  Observer <|.. Logger
  Observer <|.. Alerter
  EventEmitter --> Observer
```

## Real-world example: MVC architecture

```mermaid
classDiagram
  class Model {
    -data Map
    +getData() Map
    +setData(key, val) void
    +notify() void
  }
  class View {
    -model Model
    +render() void
    +update() void
  }
  class Controller {
    -model Model
    -view View
    +handleInput(event) void
    +updateModel(data) void
  }
  Controller --> Model : updates
  Controller --> View : refreshes
  View --> Model : reads
  Model ..> View : notifies
```

## Don'ts

- Don't use `static` or `abstract` as keywords — use `$` and `*` prefixes on the member name
- Generics use `~T~`, not `<T>` (angle brackets are HTML in markdown contexts and confuse the parser)
- Annotations must be on their own line above the class name — `class Foo <<interface>> { ... }` doesn't work
- A class block must be closed with `}`. Unclosed blocks are the #1 parse error
- Method parentheses are required: `login` is a field, `login()` is a method

## More

For more class-diagram examples (full inheritance hierarchies, design patterns, more relationship types) see `docs/beautiful-mermaid-examples.md` in the repo.
