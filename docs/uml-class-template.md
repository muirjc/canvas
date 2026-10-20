# UML Class Diagram — Intake Template

Fill in each section below, then use **Import from Template** in Canvas and
pick the *UML* diagram type. Each section maps onto Mermaid's
`classDiagram`; the mapping reference at the bottom shows how.

---

## 1. Diagram metadata

| Field | Value |
|---|---|
| Diagram title | |
| Direction (Top to bottom / Left to right / Bottom to top / Right to left) | |

---

## 2. Classes

One row per class or interface.

| Class | Stereotype | Namespace |
|---|---|---|
| | interface / abstract / enumeration / (blank) | |

- `Class` — a single word (letters, digits, `_`). Generic classes are
  written `Repository<T>`.
- `Stereotype` — optional, one word, shown as `<<interface>>` etc.
- `Namespace` — optional package name (e.g. `Billing`, or `Billing.Core`
  for a nested one); classes with the same namespace are grouped together.

---

## 3. Members (optional)

One row per attribute or method, in the order they should be listed.

| Class | Member | Kind | Visibility | Type | Parameters | Modifier |
|---|---|---|---|---|---|---|
| | | Attribute / Method | Public / Private / Protected / Package | | | Static / Abstract |

- `Type` — the attribute's type, or the method's return type (optional).
  Generic types are written `List<String>`.
- `Parameters` — methods only, as written, e.g. `String id, int count`.
- `Visibility` — blank leaves it unmarked; `+ - # ~` work too.

---

## 4. Relationships (optional)

One row per line between two classes. Read each row as a sentence:
**From** *Relationship* **To** — e.g. "Car *Inheritance* Vehicle" means Car
inherits from Vehicle.

| From | Relationship | To | Label | From multiplicity | To multiplicity |
|---|---|---|---|---|---|
| | Inheritance / Realization / Composition / Aggregation / Association / Dependency / Link | | | | |

**Relationship legend** (From → To):
- `Inheritance` — From is a subclass of To
- `Realization` — From implements the interface To
- `Composition` — From owns To; To can't exist without From
- `Aggregation` — From has To; To can exist on its own
- `Association` — From uses or knows about To
- `Dependency` — From depends on To (weaker than association)
- `Link` — a plain line, no direction

Multiplicities are optional, e.g. `1`, `0..1`, `*`, `1..*`.

---

## Mapping reference — template fields → Mermaid classDiagram

```
classDiagram
    title <Diagram title>
    direction TB | LR | BT | RL

    namespace <Namespace> {
        class <Class>~<T>~ <<<Stereotype>>> {
            <vis><Type> <Member><mod>                 (Attribute)
            <vis><Member>(<Parameters>) <Type><mod>   (Method)
        }
    }

    <To> "<To mult>" <|-- "<From mult>" <From> : <Label>     (Inheritance)
    <From> "<From mult>" ..|> "<To mult>" <To> : <Label>     (Realization)
    <From> *-- <To>      (Composition)     <From> o-- <To>   (Aggregation)
    <From> --> <To>      (Association)     <From> ..> <To>   (Dependency)
    <From> -- <To>       (Link)
```

- Visibility: Public `+`, Private `-`, Protected `#`, Package `~`.
- Modifier: Static `$`, Abstract `*` (always the last character).
- Generics: `<...>` becomes Mermaid's `~...~`.

## Example — filled template → output

| Class | Stereotype | Namespace |
|---|---|---|
| Shape | interface | |
| Circle | | |

| Class | Member | Kind | Visibility | Type | Parameters | Modifier |
|---|---|---|---|---|---|---|
| Shape | area | Method | Public | double | | Abstract |
| Circle | radius | Attribute | Private | double | | |
| Circle | area | Method | Public | double | | |
| Circle | unit | Method | Public | Circle | | Static |

| From | Relationship | To | Label | From multiplicity | To multiplicity |
|---|---|---|---|---|---|
| Circle | Realization | Shape | | | |

```
classDiagram
    class Shape <<interface>> {
        +area() double*
    }
    class Circle {
        -double radius
        +area() double
        +unit() Circle$
    }

    Circle ..|> Shape
```
