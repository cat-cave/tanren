# Run-detail Read API (P2A-0014)

This contract is the read API the Phase 2B dashboard surfaces consume. It is **frozen at P2A-0014 spec exit** (commit `P2A-0014: run-detail read API contract`). Any change after the freeze requires an addendum dated after the freeze.

All routes are scoped by org/project membership. All event/cost/Forge payloads pass through the P2A-0009 redaction serializer with the request actor's scope and an optional `rawView` opt-in. CSRF protection on state-changing methods is enforced by `services/orchestrator/src/middleware/auth.ts`; the routes below are read-only and exempt from CSRF.

Request authentication accepts either a `tanren_session` cookie (browser flow) or an `Authorization: Bearer <token>` API token (CLI flow). Routes return:

- `401` when no actor is resolved.
- `403` when the actor is not a member of the addressed org.
- `403` when the actor is not a member of the addressed project (project-access boundary).
- `404` when the run does not exist OR belongs to a different project in the same org (boundary semantics: do not reveal cross-project existence).
- `400 invalid_cursor` on malformed pagination cursors.

Response date fields are emitted as ISO-8601 strings; the Zod schemas use `z.coerce.date()` so dashboard parsers receive `Date` after round-trip.

---

## Schemas (single source of truth)

Schemas live in `services/orchestrator/src/routes/runs/contract.ts`. Re-exports for downstream consumers:

- `RunSummary`, `TaskTimelineEntry`, `RunEventRow`, `RunCostRecord`
- `RunSpecSummary`, `RunForgeBundle`, `RunDetail`
- `RunListItem`, `ProjectFeedItem`
- `CursorPage<T>`, `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`
- `encodeCursor`, `decodeCursor`, `InvalidCursorError`, `parsePageSize`
- SSE frame schemas: `SseEventName`, `SseSnapshotFrame`, `SseStatusFrame`, `SseTaskFrame`, `SseEventsFrame`, `SseCostsFrame`, `SseHeartbeatFrame`, `SseDrainedFrame`

Event and cost bigserial identifiers cross JSON as canonical positive decimal strings. SSE cursors use the same representation and additionally allow `"0"` for an empty baseline. They are never coerced through JavaScript `number`.

---

## `GET /orgs/:orgId/projects/:projectId/runs`

Lists runs in the project, newest-first.

**Query params**

- `status` (optional): filter by `RunStatus` (e.g. `running`, `completed`, `failed`).
- `specId` (optional): filter by spec.

**Response**: `{ items: RunListItem[] }`

`RunListItem` extends `RunSummary` with:

- `specTitle`: convenience join from `specs.title`.
- `costTotalUsd`: stringified Postgres `NUMERIC(14,6)` sum of cost_usd for the run.
- `lastEventAt`: most-recent event timestamp.
- `needsReview`: derived flag. `true` when the run has a PR URL and the outcome is review-needing (`halted`, `escape_hatch_hit`, `retry_budget_exhausted`, any `phase*_complete`, `pending`, or `null`).

**Redaction**: the list does not embed event payloads; redaction does not apply.

**Example**

```sh
curl -sS \
  -H "Authorization: Bearer $TANREN_API_TOKEN" \
  "https://api.tanren.dev/orgs/org_acme/projects/project_phase1/runs?status=running"
```

---

## `GET /orgs/:orgId/projects/:projectId/runs/:runId`

Returns a full `RunDetail` snapshot.

**Response**: `RunDetail`

```ts
{
  run: RunSummary,
  spec: { specId, title, description, behaviorIds, milestoneId },
  tasks: TaskTimelineEntry[],
  recentEvents: RunEventRow[],   // capped at RECENT_EVENT_CAP = 50 chronologically
  costs: RunCostRecord[],
  insights: Insight[],            // P2A-0020 insights filtered to this run + spec
  forgeThread: { threadId, recentTurns } | null
}
```

- `recentEvents` is the most-recent 50 events ordered chronologically (oldest first). For full pagination call `/events` (below).
- `costs` returns every cost record for the run (uncapped — Phase 2 runs emit ≤ ~50 cost records). Pagination via `/costs` is available for very long runs.
- `insights` filters the project's `loadInsightsForProject` output to entries whose payload references this run (`pace_anomaly.runId`) or spec (`retry_hotspot.specId`); `model_mismatch` is class-level and surfaces for any run in the class.
- `forgeThread` returns the most-recent `forge_threads` row scoped to this run with up to 50 most-recent turns, redacted by `audience` per P2A-0019 rules. `null` when no thread exists.

**Redaction**: events and Forge turn render payloads pass through the P2A-0009 serializer. `redactedPaths` on each event row lists fields the actor cannot see. Costs do not carry sensitive payload values in their typed view (the `cost_source_raw` jsonb stays in the DB and is not surfaced here).

**Raw-view opt-in**: append `?raw=true` or send `X-View-Raw: true`. Only elevated scopes (`platform:admin` / `org:admin`) receive raw values; the serializer emits a `redaction.raw_access` audit event listing the paths returned.

**Errors**

- `404 run_not_found`: run does not exist, or the run belongs to a different project than the URL says.
- `403 project_access_denied`: actor is not a project/org member.

---

## `GET /orgs/:orgId/projects/:projectId/runs/:runId/events`

Cursor-paginated events for a run.

**Query params**

- `pageSize` (optional): default 50, max 200.
- `cursor` (optional): opaque token returned by the previous page's `nextCursor`. Malformed cursors return `400 invalid_cursor`.

**Response**: `CursorPage(RunEventRow)`

```ts
{
  items: RunEventRow[],   // ordered oldest → newest
  nextCursor: string | null
}
```

**Cursor format**: base64 of `<isoTs>:<id>`. `(ts, id)` is the row's `(ts, id)` tuple. Decoder rejects non-base64, missing separator, bad timestamps, or non-integer ids.

**Redaction**: same as run detail. Pass `?raw=true` to opt into raw view (audit-emitting).

**Example**

```sh
curl -sS \
  -b "tanren_session=$COOKIE" \
  "https://api.tanren.dev/orgs/org_acme/projects/project_phase1/runs/run_x/events?pageSize=100"
```

---

## `GET /orgs/:orgId/projects/:projectId/runs/:runId/costs`

Cursor-paginated cost records for a run.

**Query params**: same as `/events`.

**Response**: `CursorPage(RunCostRecord)` — ordered oldest → newest by `(recorded_at, id)`.

`RunCostRecord` mirrors the persisted `cost_records` row:

- Disjoint token buckets: `inputTokens`, `cachedInputTokens`, `cacheCreationTokens`, `outputTokens`, `reasoningOutputTokens`, `totalTokens`.
- `costUsd`: a fixed-precision dollar string, or `null` when cost is unknown (best-effort).
- `billingMode`: `per_token` | `subscription` | `self_hosted` | `unattributed`.
- `costBasis`: `ccusage` | `provider_response` | `credits` | `unknown` | `unattributed` (`unknown` ⇒ `costUsd` is null).

---

## `GET /orgs/:orgId/projects/:projectId/runs/:runId/forge`

Returns the most-recent run-scoped Forge thread plus up to 50 most-recent turns.

**Response**:

```ts
{ threadId: string, turns: ForgeTurnRow[] }
// or { thread: null, turns: [] } when no thread exists
```

Each turn carries the same `render` (`ForgeAnswer` payload from P2A-0008) the Forge tool layer returns. Audience-tier filtering happens in the store (`ForgeTurnStore.list`) so a `project:member` actor never sees `org:admin`-audience turns.

---

## `GET /orgs/:orgId/projects/:projectId/runs/:runId/stream` (SSE)

Server-Sent Events stream for live run updates. The stream is event-driven: it `LISTEN`s on the Postgres `tanren_run` channel and re-polls its deltas on a `NOTIFY` wake (`db/src/notify.ts`), with a long backstop interval only bounding latency if a `NOTIFY` is ever missed. Each frame has a connection-local `id`, `retry: 1000`, a strict event name, and one JSON object. A reconnect always begins with a new complete snapshot; the protocol id is not a database cursor.

**Frames**

```text
id: 1
retry: 1000
event: snapshot
data: { runId, projectId, run, tasks, recentEvents, costs, eventCursor, costCursor, taskWatermark }

event: status
data: { runId, projectId, status, outcome }

event: task
data: { runId, projectId, task, taskWatermark }

event: events
data: { runId, projectId, events, eventCursor }

event: costs
data: { runId, projectId, costs, costCursor }

event: heartbeat
data: { runId, projectId, ts }

event: drained
data: { runId, projectId, status, outcome, eventCursor, costCursor, taskWatermark }
```

**Stream end conditions**

- A terminal `status` is workflow truth, not proof that accounting and event delivery are complete. The server continues through post-terminal deltas.
- After a quiet post-terminal poll proves all currently committed deltas were sent, the server emits one strict `drained` receipt whose cursors and task watermark equal the preceding stream state, then ends the response.
- Clients close only after validating a matching `drained` receipt. EOF, transport error, terminal status, heartbeat absence, and elapsed time never establish correctness; clients remain eligible for reconnection. A reconnect snapshot reconciles the full state before a later drain can close it.
- Every known frame is validated in full and against the SSR-rendered run/project identity before any accounting, cursor, workflow state, or DOM mutation. Deltas before the first valid snapshot are rejected.

**Redaction**: same as `/events`. `?raw=true` propagates.

**Example**

```sh
curl -sS -N \
  -H "Authorization: Bearer $TANREN_API_TOKEN" \
  "https://api.tanren.dev/orgs/org_acme/projects/project_phase1/runs/run_x/stream"
```

---

## `GET /orgs/:orgId/projects/:projectId/insights`

(Existing in P2A-0020; included here for completeness.) Returns every typed `Insight` for the project. The shape is the source of truth for `RunDetail.insights[]` filtering — that field is just a subset of this list scoped to one run + spec.

---

## `GET /orgs/:orgId/projects/:projectId/feed`

Project activity feed — events across every run in the project, newest-first, cursor-paginated.

**Query params**: same as `/events`.

**Response**: `{ items: ProjectFeedItem[]; nextCursor: string | null }`

`ProjectFeedItem` narrows `RunEventRow` to require non-null `runId`. Cursor encodes the oldest item already shown so subsequent pages walk backward in time.

---

## Quality bar

- **Frozen**: every visible field is contract-typed. The Zod schemas in `contract.ts` are the spec.
- **No UI shaping**: the API ships data only — no `displayLabel`, no UI variant ids.
- **Redaction discipline**: every event/Forge payload returns through the P2A-0009 serializer. Raw-view opt-in is auditable.
- **Pagination**: cursor format is opaque, validated, and uniform across `/events`, `/costs`, and `/feed`.
- **Phase 1 fixture replay**: the orchestrator test suite includes `runRoutes.contract.test.ts` which seeds a fixture run and asserts `RunDetail` has all six top-level fields plus planner/writer/checker/auditor events. The acceptance gate (P2A-0015) wires the same loader against the real fixture-easy run.

---

## Change-control

### 2026-07-14 addendum — identity-bound drain and exact cursors

PR #856 clean-replaces the timer-based terminal heuristic with the identity-bound `drained` protocol above. It also changes event/cost bigserial wire ids from `number | string` to canonical strings, adds project identity and monotonic cursors to every state-bearing frame, and adds task watermarks. The dashboard migrates atomically in the same change: SSR and live updates use one exact millionth-of-a-dollar/safe-token reducer, terminal truth stays visible while stream integrity is unverified, and the same-origin proxy addresses the already-resolved org/project directly so transient upstream failure is distinct from authorization and not-found.

Any change to a schema in `contract.ts` requires:

1. An addendum section in this doc with a date and short rationale.
2. A migration plan for any dashboard surface that consumed the old shape.

Adding a new SSE frame name does **not** require an addendum — clients ignore unknown event types per the SSE spec. Renaming or removing an existing frame does.
