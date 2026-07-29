# Contract: Standards Metadata & Version Listing

Two read/write surfaces change. Neither adds an endpoint; both extend existing ones.

---

## 1. Standards — name, description, retirement date

### Create / update a standard

Existing endpoints gain two fields.

**Request** additionally accepts:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes, for newly created standards | Human-readable identity (FR-021) |
| `description` | string | no | Statement of intent (FR-022) |

**Response** additionally returns `name`, `description`, `createdAt`, and `retiredAt`.

| Guarantee | Detail |
|---|---|
| `name` is present on every standard returned | Including pre-existing rows, via backfill (FR-026) |
| `description` may be null | A standard need not elaborate beyond its name |
| `createdAt` is always returned | Already stored; FR-023 requires it be surfaced |
| `retiredAt` is returned only when retired | Null otherwise (FR-025) |
| Validation rules are unchanged | Metadata is descriptive; it never affects diagram validation |

### Retirement — both paths must record the date

`status = 'retired'` is written in **two** places in `standard.service.ts`. The contract applies to
both:

| Path | Trigger | Contract |
|---|---|---|
| `retireStandard(id)` | An admin explicitly retires a standard | Sets `status='retired'` **and** `retired_at = now()` |
| `publishStandard(id)` | Publishing auto-retires the previously published standard for that diagram type, in the same transaction | Sets `status='retired'` **and** `retired_at = now()` on the superseded standard |

**A standard retired by supersession must carry a retirement date**, exactly as one retired
explicitly does. This is the more common path in practice and the easier of the two to overlook —
contract tests must cover it specifically.

| Guarantee | Detail |
|---|---|
| `retired_at` set on both paths | |
| Set once | Retiring an already-retired standard does not overwrite the original date |
| Transactional | The supersession path retains its existing BEGIN/COMMIT semantics |

### Backfill

| Guarantee | Detail |
|---|---|
| No standard is nameless after migration | Existing rows get a name derived from diagram type and version (e.g. `flowchart v3`) |
| No invented intent | `description` stays null rather than being fabricated |
| No retroactive dates | `retired_at` stays null for already-retired rows — the date was never recorded and cannot be recovered |

---

## 2. Version listing — bounded by default, searchable

The existing version-listing endpoint gains two optional query parameters. Ordering
(`sequence_number DESC`) is unchanged.

| Parameter | Type | Default | Behaviour |
|---|---|---|---|
| `limit` | integer | **5** | Maximum versions returned (FR-028) |
| `q` | string | — | Filters on version number and creation date (FR-030) |

**Response** additionally indicates whether more versions exist beyond those returned, so the
client can say so without fetching them (FR-029).

| Guarantee | Detail |
|---|---|
| Default response is capped at 5 | Regardless of how many versions exist |
| Fewer than the cap returns all, with no "more exist" signal | The boundary case at exactly 5 must not imply hidden versions (spec edge case) |
| A searched version is fully restorable | Identical to one returned by default (FR-031) |
| An unmatched search returns an empty result, not an error | The client distinguishes "no matches" from failure (FR-032) |
| No version is ever deleted | The cap is a display and transfer default, not retention |
| Access control unchanged | Version listing keeps its existing permission requirements |

---

## 3. Preserved across both surfaces

| Guarantee | Detail |
|---|---|
| No endpoint removed or renamed | Both changes are additive to existing routes |
| Existing clients keep working | New request fields are optional except `name` on creation; new response fields are additive |
| Existing contract tests pass unchanged | Except where they assert the *absence* of the new fields |
| No change to diagram storage | `diagram_versions` and `diagrams` are untouched |
