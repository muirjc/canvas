# Entity Relationship Diagram — Intake Template

Fill in each section below, then use **Import from Template** in Canvas and
pick the *ERD* diagram type. Each section maps onto Mermaid's `erDiagram`;
the mapping reference at the bottom shows how.

---

## 1. Diagram metadata

| Field | Value |
|---|---|
| Diagram title | |
| Direction (Top to bottom / Left to right / Bottom to top / Right to left) | |

---

## 2. Entities

One row per entity (table). Names may contain spaces; Canvas generates the
identifier and keeps the name as the label.

| Name |
|---|
| |

---

## 3. Attributes (optional)

One row per column. The entity must be listed in Section 2.

| Entity | Attribute | Type | Key | Comment |
|---|---|---|---|---|
| | | | PK / FK / UK | |

- `Key` — blank, or one or more of `PK` (primary key), `FK` (foreign key),
  `UK` (unique), separated by commas (e.g. `PK, FK`).
- Spaces in `Attribute` and `Type` are replaced by `_` / removed, since
  Mermaid allows neither (e.g. `decimal(10, 2)` becomes `decimal(10,2)`).

---

## 4. Relationships

One row per relationship line. Read each row as a sentence:
*(From cardinality)* **From** *Label* *(To cardinality)* **To** — for example
"Exactly one Customer places Zero or more Orders".

| From | From cardinality | Label | To cardinality | To | Identifying |
|---|---|---|---|---|---|
| | Exactly one / Zero or one / One or more / Zero or more | | Exactly one / Zero or one / One or more / Zero or more | | Yes / No |

- `Identifying` — `Yes` (the default) draws a solid line: the To entity
  can't exist without the From entity. `No` draws a dashed line.
- `Label` — a short verb phrase; left blank it becomes "relates to"
  (Mermaid requires one).

---

## Mapping reference — template fields → Mermaid erDiagram

```
erDiagram
    title <Diagram title>
    direction TB | LR | BT | RL

    <ID>[<Name>] {                       (the [<Name>] part only when the name isn't a plain identifier)
        <Type> <Attribute> <Key> "<Comment>"
    }

    <FROM> <from-card>--<to-card> <TO> : <Label>      (Identifying = Yes)
    <FROM> <from-card>..<to-card> <TO> : <Label>      (Identifying = No)
```

| Cardinality | From side | To side |
|---|---|---|
| Exactly one | `\|\|` | `\|\|` |
| Zero or one | `\|o` | `o\|` |
| One or more | `}\|` | `\|{` |
| Zero or more | `}o` | `o{` |

## Example — filled template → output

| Name |
|---|
| Customer |
| Order |
| Order Line |

| Entity | Attribute | Type | Key | Comment |
|---|---|---|---|---|
| Customer | id | string | PK | |
| Customer | email | string | UK | Login name |
| Order | id | string | PK | |
| Order | customerId | string | FK | |
| Order Line | quantity | int | | |

| From | From cardinality | Label | To cardinality | To | Identifying |
|---|---|---|---|---|---|
| Customer | Exactly one | places | Zero or more | Order | No |
| Order | Exactly one | contains | One or more | Order Line | Yes |

```
erDiagram
    Customer {
        string id PK
        string email UK "Login name"
    }
    Order {
        string id PK
        string customerId FK
    }
    Order_Line[Order Line] {
        int quantity
    }

    Customer ||..o{ Order : places
    Order ||--|{ Order_Line : contains
```
