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
- SSE frame schemas: `SseEventName`, `SseStatusFrame`, `SseTaskFrame`, `SseEventsFrame`, `SseCostsFrame`, `SseHeartbeatFrame`

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
- `billingMode`: `per_token` | `subscription` | `self_hosted`.
- `costBasis`: `ccusage` | `provider_pricing` | `unknown` (`unknown` ⇒ `costUsd` is null).

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

Server-Sent Events stream for live run updates. v0 uses a poll loop at 1s tick; the same frame format is preserved when the orchestrator's workflow swaps in a Postgres `LISTEN/NOTIFY` source later.

**Frames**

```text
event: snapshot
data: { run, tasks, recentEvents, costs }   // initial frame: partial RunDetail

event: status
data: { runId, status, outcome }

event: task
data: TaskTimelineEntry                      // one frame per changed task

event: events
data: { events: RunEventRow[] }              // batch of new events (redacted)

event: costs
data: { costs: RunCostRecord[] }

event: heartbeat
data: { ts: ISO-8601 }                       // every 15s when otherwise idle
```

**Stream end conditions**

- The connection closes when the run reaches a terminal status (`completed`, `failed`, `cancelled`, `halted`, or legacy `done`) AND one final post-terminal poll has flushed remaining deltas.
- Clients should close the connection on the terminal `status` frame; a 60s client-initiated keepalive is recommended.

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

Any change to a schema in `contract.ts` requires:

1. An addendum section in this doc with a date and short rationale.
2. A roadmap note linking the addendum from `docs/roadmap/phase-2a-specs.md`.
3. A migration plan for any 2B dashboard surface that consumed the old shape.

Adding a new SSE frame name does **not** require an addendum — clients ignore unknown event types per the SSE spec. Renaming or removing an existing frame does.
