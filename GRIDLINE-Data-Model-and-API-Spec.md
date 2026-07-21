# GRIDLINE — Server Data Model & API/Event Specification

This sketches the backend data model and API/event shape for turning GRIDLINE's Realtime view into a shared, multi-user, always-online client-server system. It maps directly onto the entities the client already uses (feeders, nodes, lines, transformers, interlinks) so the front-end's rendering logic barely changes — only where the data comes from changes.

Scope note: this covers the **Realtime view only**. The Simulator view stays a local, per-user, client-side sandbox with no server involvement, since it's a personal what-if tool rather than shared operational state.

---

## 1. Data model

### 1.1 `users`

| Column | Type | Notes |
|---|---|---|
| id | uuid (PK) | |
| name | text | |
| email | text (unique) | |
| role | enum: `field_staff`, `control_center`, `admin` | drives permission scope |
| assigned_section_ids | uuid[] | optional — restricts a field technician to specific sections/feeders |
| created_at, updated_at | timestamp | |

Auth itself (password hash / SSO federation) sits in a standard `auth_credentials` or is delegated entirely to an identity provider (AD/SSO) if the utility already has one — either way, `users` is the row every event/audit entry references.

### 1.2 `sections`

Maps to the existing "Section" sheet (a named grouping/heading, e.g. a division or circle).

| Column | Type | Notes |
|---|---|---|
| id | uuid (PK) | |
| name | text | |
| details | jsonb | free-form key/value pairs, same as the current Section sheet parsing |

### 1.3 `feeders`

| Column | Type | Notes |
|---|---|---|
| id | uuid (PK) | |
| section_id | uuid (FK → sections) | |
| name | text | |
| kv | numeric | voltage |
| location | text | |
| poc | text | point of contact |
| state | enum: `On`, `Off` | |
| last_tripped | timestamp, nullable | |
| risks | text, nullable | |
| version | integer | optimistic-lock counter, see §3 |
| updated_at, updated_by | timestamp, uuid (FK → users) | |

### 1.4 `nodes`

Breakers/junctions/sources — mirrors `state.nodes` in the client.

| Column | Type | Notes |
|---|---|---|
| id | uuid (PK) | |
| feeder_id | uuid (FK → feeders) | |
| kind | enum: `source`, `breaker` | |
| breaker_type | enum: `AB`, `RMU`, `Split`, `Tap`, null | null when kind = source |
| label | text | |
| state | enum: `Open`, `Closed`, null | null for non-switchable (Split/Tap) |
| version | integer | |
| updated_at, updated_by | timestamp, uuid | |

### 1.5 `lines`

Edges between nodes — also carries the per-bay open/closed state for RMU outgoing bays.

| Column | Type | Notes |
|---|---|---|
| id | uuid (PK) | |
| feeder_id | uuid (FK → feeders) | |
| from_node_id, to_node_id | uuid (FK → nodes) | |
| name | text | |
| breaker_state | enum: `Open`, `Closed` | the "bay" state at the from-node end |
| version | integer | |
| updated_at, updated_by | timestamp, uuid | |

### 1.6 `transformers`

| Column | Type | Notes |
|---|---|---|
| id | uuid (PK) | |
| name | text | |
| capacity_kva | numeric | |
| pole_name | text, nullable | |
| load_r, load_y, load_b | numeric, nullable | last-read phase loads |
| load_captured_at | timestamp, nullable | |
| last_fault_date | timestamp, nullable | |
| last_fault_reason | text, nullable | |
| node_id | uuid (FK → nodes), nullable | set for RMU/Split/Tap-anchored transformers |
| line_id | uuid (FK → lines), nullable | set for line-tapped transformers |
| updated_at, updated_by | timestamp, uuid | |

*(exactly one of `node_id` / `line_id` is set — same constraint the client already enforces)*

### 1.7 `interlinks`

Ring ties between two nodes, possibly across feeders.

| Column | Type | Notes |
|---|---|---|
| id | uuid (PK) | |
| name | text | |
| node_a_id, node_b_id | uuid (FK → nodes) | |
| breaker_type | enum: `AB`, `RMU` | |
| switchable | boolean | only a switchable interlink can be toggled |
| switch_state | enum: `NC`, `NO` | always forced `NC` on creation/import |
| version | integer | |
| updated_at, updated_by | timestamp, uuid | |

### 1.8 `audit_log` (append-only)

The single most important addition versus the current client-only app — every mutation is recorded here, independent of whatever the "current" tables say.

| Column | Type | Notes |
|---|---|---|
| id | bigserial (PK) | |
| entity_type | enum: `feeder`, `node`, `line`, `interlink`, `transformer` | |
| entity_id | uuid | |
| action | enum: `create`, `update`, `delete` | |
| field_changed | text, nullable | e.g. `state`, `breaker_state`, `switch_state` |
| old_value, new_value | jsonb | |
| performed_by | uuid (FK → users) | |
| performed_via | enum: `mobile`, `web` | |
| performed_at | timestamp | |

This table is what control centers query for "who did what, when" — it's the operational record, and it's also exactly the payload that gets broadcast over the real-time channel (§3).

---

## 2. REST API

All mutation endpoints require a valid session/JWT and are checked against the user's role + assigned sections. Every mutating endpoint accepts an `expectedVersion` and returns `409 Conflict` with the current row if it doesn't match (optimistic locking — see §4).

```
Auth
  POST   /api/auth/login
  POST   /api/auth/logout

Full snapshot (initial load / reconnect resync)
  GET    /api/network                     -> { feeders[], nodes[], lines[], transformers[], interlinks[], sections[] }

Feeders
  POST   /api/feeders
  PATCH  /api/feeders/:id                 { state?, risks?, ..., expectedVersion }
  DELETE /api/feeders/:id

Nodes
  POST   /api/nodes
  PATCH  /api/nodes/:id                   { state?, label?, expectedVersion }   // AB/RMU open-close
  DELETE /api/nodes/:id                   // cascades: see §5

Lines
  POST   /api/lines
  PATCH  /api/lines/:id                   { breakerState?, expectedVersion }    // RMU bay open/close
  DELETE /api/lines/:id                   // cascades: see §5

Interlinks
  POST   /api/interlinks
  PATCH  /api/interlinks/:id              { switchState?, expectedVersion }     // only if switchable
  DELETE /api/interlinks/:id

Transformers
  POST   /api/transformers
  PATCH  /api/transformers/:id
  DELETE /api/transformers/:id

Audit
  GET    /api/audit?entityType=&entityId=&from=&to=&user=
```

All mutations flow through REST (not the socket) — this keeps the mental model simple: HTTP for "do a thing," WebSocket purely for "everyone gets told a thing happened." No commands are ever accepted over the socket.

---

## 3. Real-time event channel (WebSocket)

One socket connection per client, subscribed to the section(s)/feeder(s) it cares about (a control-center dashboard might subscribe to everything; a field technician's app might subscribe only to their assigned section to cut bandwidth).

Every successful mutation triggers exactly one broadcast event, shaped identically to an `audit_log` row:

```json
{
  "type": "node.updated",
  "entityId": "node_8f2a...",
  "field": "state",
  "oldValue": "Closed",
  "newValue": "Open",
  "version": 14,
  "performedBy": { "id": "user_412", "name": "R. Kumar", "role": "field_staff" },
  "performedVia": "mobile",
  "performedAt": "2026-07-20T11:42:03+05:30"
}
```

Event `type` values: `feeder.updated`, `node.updated`, `node.deleted` (includes `cascadedNodeIds`/`cascadedLineIds`), `line.updated`, `line.deleted`, `interlink.updated`, `interlink.deleted`, `*.created` for each entity type.

Client behavior on receipt: look up the entity by `entityId`, apply the field change directly to local state, re-run the existing `renderAll()`. This is a very small change from what GRIDLINE already does — today a local click calls `saveState(); renderAll();`; tomorrow a socket event calls the same `renderAll()`, just triggered remotely.

On socket reconnect (brief network blip), the client simply re-fetches `GET /api/network` and replaces its local snapshot wholesale rather than trying to replay missed events — safe and simple given reliable connectivity means these gaps are seconds, not hours.

---

## 4. Concurrency model

Every switchable/mutable row carries a `version` integer. A `PATCH` must include the `expectedVersion` it read; the server does the update conditionally (`UPDATE ... WHERE id = ? AND version = ?`) and increments `version` on success. If zero rows were affected, someone else changed it first — return `409` with the current row, and the client re-fetches and shows the operator the up-to-date state before they retry. Because everyone is always connected, this is a rare, few-hundred-millisecond race, not something that needs a merge UI.

---

## 5. Cascading deletes

"Delete this branch" (and its confirmation dialog) maps directly to `DELETE /api/nodes/:id`: the server runs the same subtree logic the client's `collectSubtree()`/`deleteLine()` already do today (find every node/line downstream, plus any transformers and interlinks touching them), deletes them all in one transaction, writes one `audit_log` entry per affected entity, and broadcasts a single `node.deleted` event carrying the full list of cascaded IDs so every client can remove them from its canvas in one pass.

---

## 6. Suggested stack

- **API + WebSocket server:** Node.js (Express or Fastify) + `socket.io`, or a managed realtime layer (Supabase Realtime / Ably) sitting in front of Postgres if you'd rather not run the socket infra yourselves.
- **Database:** PostgreSQL — the entities above are relational by nature (foreign keys, referential integrity for cascades), and `jsonb` columns cover the free-form bits (section details, audit old/new values).
- **Auth:** JWT sessions, or SSO/OIDC against the utility's existing identity provider if one exists.

This is intentionally the simple end of the spectrum — no event sourcing as the source of truth, no CRDTs, no offline queue — because reliable field connectivity removes the need for any of that. The `audit_log` table gives you the traceability benefit of event sourcing without taking on its complexity everywhere else.
