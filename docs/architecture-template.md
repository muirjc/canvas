# Architecture Diagram — Intake Template

For the *Network*, *Deployment* and *Cloud Infrastructure* diagram types.
Fill in each section below, then use **Import from Template** in Canvas and
pick one of those types. Each section maps onto Mermaid's
`architecture-beta`; the mapping reference at the bottom shows how.

---

## 1. Diagram metadata

| Field | Value |
|---|---|
| Diagram title | |

---

## 2. Groups (optional)

Boxes that hold services — a VPC, a subnet, a region, a data centre. Groups
can sit inside other groups.

| Group | Icon | Inside group |
|---|---|---|
| | | |

---

## 3. Services

One row per service, server, database, etc.

| Service | Icon | Group |
|---|---|---|
| | | |

---

## 4. Junctions (optional)

Invisible routing points, used to split one connection into several.

| Junction | Group |
|---|---|
| | |

---

## 5. Connections

One row per line. A connection runs between services or junctions (not
groups), leaving and entering at the given side of each.

| From | From side | To | To side | Arrow |
|---|---|---|---|---|
| | Left / Right / Top / Bottom | | Left / Right / Top / Bottom | Yes / No |

- Sides default to From **Right**, To **Left**.
- `Arrow` — `Yes` (the default) points at To; `No` draws a plain line.

**Icon legend** (Sections 2 and 3):
- blank — `server` for a service, `cloud` for a group
- Mermaid's built-in icons: `cloud`, `database`, `disk`, `internet`, `server`
- Canvas's icon libraries: `aws:<icon>` (e.g. `aws:lambda`, `aws:s3`) or
  `azure:<icon>` (e.g. `azure:storage-accounts`) — the icon id as shown in
  Canvas's icon palette
- any other `prefix:name` is passed through as an iconify.design icon
  (e.g. `logos:kubernetes`)

---

## Mapping reference — template fields → Mermaid architecture-beta

```
architecture-beta
    title <Diagram title>

    group <id>(<icon>)[<Group>]
    group <id>(<icon>)[<Group>] in <parent id>
    service <id>(<icon>)[<Service>] in <group id>
    junction <id> in <group id>

    <from>:R --> L:<to>       (Arrow = Yes; sides L, R, T, B)
    <from>:R -- L:<to>        (Arrow = No)
```

- Ids are generated from the names (e.g. "Web Server" → `webServer`).
- `aws:` / `azure:` icons are recorded in Canvas's front matter so the
  right artwork is drawn; the DSL line carries the bare icon id.

## Example — filled template → output

| Group | Icon | Inside group |
|---|---|---|
| Public Cloud | cloud | |

| Service | Icon | Group |
|---|---|---|
| Web Server | server | Public Cloud |
| Database | database | Public Cloud |
| Users | internet | |

| From | From side | To | To side | Arrow |
|---|---|---|---|---|
| Users | Right | Web Server | Left | Yes |
| Web Server | Bottom | Database | Top | No |

```
architecture-beta
    group publicCloud(cloud)[Public Cloud]
    service webServer(server)[Web Server] in publicCloud
    service database(database)[Database] in publicCloud
    service users(internet)[Users]

    users:R --> L:webServer
    webServer:B -- T:database
```
