# C4 Container / Component / Deployment Diagram — Intake Template

For the *C4 Container*, *C4 Component* and *C4 Deployment* diagram types
(for a Level 1 System Context diagram use `c4-context-template.md`
instead). Fill in each section below, then use **Import from Template** in
Canvas and pick the diagram type. The type you pick decides which element
types are allowed (see the legend in Section 3).

---

## 1. Diagram metadata

| Field | Value |
|---|---|
| Diagram title | |

---

## 2. Boundaries (optional)

Boxes that group elements: the system whose containers you're showing, a
container whose components you're showing, or — on a Deployment diagram —
the servers, clusters and regions the containers run on. Boundaries can sit
inside other boundaries.

| Boundary | Type | Inside | Technology | Description |
|---|---|---|---|---|
| | System / Container / Enterprise / Boundary / Node | | | |

**Type legend:**
- `System`, `Container`, `Enterprise` — a named group (Container and
  Component diagrams). `Technology` and `Description` aren't used.
- `Boundary` — a generic group; `Technology` is shown as its type.
- `Node` — a deployment node: a server, VM, container runtime, cloud region
  (Deployment diagrams only, and the only type allowed there).
  `Technology` is its type (e.g. `Ubuntu 22.04`, `Kubernetes`), plus an
  optional `Description`.

---

## 3. Elements

One row per person, system, container or component.

| Name | Type | Internal/External | Technology | Description | Inside |
|---|---|---|---|---|---|
| | | Internal / External | | | |

**Type legend** — and the diagram types each is allowed on:

| Type | Container | Component | Deployment |
|---|---|---|---|
| `Person` | ✓ | ✓ | ✓ |
| `System`, `SystemDb`, `SystemQueue` | ✓ | ✓ | ✓ |
| `Container`, `ContainerDb`, `ContainerQueue` | ✓ | ✓ | ✓ |
| `Component`, `ComponentDb`, `ComponentQueue` | | ✓ | |

- `Db` / `Queue` variants draw as a database / queue.
- `External` adds `_Ext` (drawn grey), e.g. an external system.
- `Technology` — containers and components only (e.g. `Java, Spring MVC`).
- `Inside` — optional, a boundary from Section 2.

---

## 4. Relationships

One row per arrow, between any two elements (not boundaries).

| From | To | Label | Technology |
|---|---|---|---|
| | | | |

---

## Mapping reference — template fields → Mermaid C4 DSL

```
C4Container | C4Component | C4Deployment
    title <Diagram title>

    System_Boundary(<id>, "<Boundary>") {
        Container(<id>, "<Name>", "<Technology>", "<Description>")
    }
    Boundary(<id>, "<Boundary>", "<Technology>") { ... }
    Deployment_Node(<id>, "<Boundary>", "<Technology>", "<Description>") { ... }

    Person(<id>, "<Name>", "<Description>")
    System_Ext(<id>, "<Name>", "<Description>")
    ContainerDb(<id>, "<Name>", "<Technology>", "<Description>")

    Rel(<from>, <to>, "<Label>", "<Technology>")
```

- Ids are generated from the names (e.g. "Web App" → `webApp`).
- Double quotes in any text become single quotes (Mermaid C4 text can't
  contain `"`).

## Example — filled template → output

| Boundary | Type | Inside | Technology | Description |
|---|---|---|---|---|
| Internet Banking | System | | | |

| Name | Type | Internal/External | Technology | Description | Inside |
|---|---|---|---|---|---|
| Customer | Person | Internal | | A bank customer | |
| Web App | Container | Internal | Java, Spring MVC | Delivers the web front end | Internet Banking |
| Database | ContainerDb | Internal | PostgreSQL | Stores accounts | Internet Banking |
| Mail System | System | External | | Sends e-mails | |

| From | To | Label | Technology |
|---|---|---|---|
| Customer | Web App | Uses | HTTPS |
| Web App | Database | Reads from and writes to | JDBC |
| Web App | Mail System | Sends e-mail using | SMTP |

```
C4Container
    Person(customer, "Customer", "A bank customer")
    System_Ext(mailSystem, "Mail System", "Sends e-mails")
    System_Boundary(internetBanking, "Internet Banking") {
        Container(webApp, "Web App", "Java, Spring MVC", "Delivers the web front end")
        ContainerDb(database, "Database", "PostgreSQL", "Stores accounts")
    }

    Rel(customer, webApp, "Uses", "HTTPS")
    Rel(webApp, database, "Reads from and writes to", "JDBC")
    Rel(webApp, mailSystem, "Sends e-mail using", "SMTP")
```
