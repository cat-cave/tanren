# run-location — O(1) org-scoped run location with fail-closed client resolution

**Phase**: hardening / PR #937 repair  
**State at admission**: contribution exists at `9920900a`; fail-closed client +
org-bind + contract freeze incomplete  
**Purpose**: resolve `/runs/:runId` to a single org+project location via one
org-scoped lookup per visible org, never a project/run-list fan-out, and fail
closed on every non-definitive probe outcome.

## Dependencies

**Hard build dependencies**

- Existing run-detail read API (`docs/contracts/run-detail-api.md`, P2A-0014)
  and `assertProjectAccess` / `actorCanAccessOrg` gates.
- Cameron DeMille's PR #937 contribution (`perf(dashboard): resolve run location
directly`, head `9920900af897c63630701f582656e0dcc4ebee4f`) — preserve the
  O(1) org-scoped route; repair fail-closed semantics on top of it.

**Downstream consumers**

- Dashboard run-detail, review, SSE proxy, and recovery surfaces that address
  runs by bare `runId`.
- Future BFF/cursor work that edits `api/orchestrator.ts` must rebase onto this
  repaired authority rather than reintroducing list fan-out.

## Exclusive ownership

- `services/orchestrator/src/routes/runs/index.ts` (location route arm only)
- `services/orchestrator/src/routes/runs/contract.ts` (`RunLocation` schema)
- `services/dashboard/src/api/runLocation.ts`
- `services/dashboard/src/api/orchestrator.ts` (`findRunLocation` surface)
- `services/dashboard/src/api/types.ts` (`RunLocation` / result type exports)
- `services/dashboard/src/routes/runs/index.tsx` (location outcome UI)
- `services/dashboard/src/routes/runs/halted.tsx` (location outcome UI)
- `services/dashboard/src/routes/runs/runLocationOutcome.tsx`
- `services/orchestrator/tests/runLocation.route.test.ts`
- `services/dashboard/tests/findRunLocation.test.ts`
- `services/dashboard/tests/runDetail.render.fixtures.ts`
- `services/dashboard/tests/runDetail.sse.test.ts`
- `services/dashboard/tests/recovery.render.fixtures.ts`
- `docs/contracts/run-detail-api.md` (location addendum)
- `docs/roadmap/mission-complete/nodes/cards/run-location.md`
- `contracts/json/http/RunLocation.json` (schema export)
- `services/dashboard/src/api/http.gen.ts` (generated; via catalog entry)
- `services/orchestrator/src/engine/schemaExport/catalog.ts` (`RunLocation` entry)

## Shared-resource leases, not owned paths

Serialize concurrent edits to:

- `services/dashboard/src/api/orchestrator.ts`
- `services/orchestrator/src/routes/runs/contract.ts`
- `services/orchestrator/tests/helpers/runRoutesPool.ts`

No migration, nav, `screens.ts`, or `main.ts` changes. No alternate fan-out
authority path may remain after this card.

## Consumes

- `fetchRunSummary(client, runId, orgId)` (org-bound SQL).
- `assertProjectAccess` → `{ orgId }` (bind to path/run org, including
  `platform:admin`).
- Operator-visible org list (`GET /orgs`) as the only multi-tenant fan-in.

## Produces

- `GET /orgs/:orgId/runs/:runId/location` → `200 RunLocation` |
  `403 { error: "org_access_denied" }` |
  `404 { error: "run_not_found" }` (missing, cross-org, project-denied, or
  project-org mismatch — indistinguishable).
- Dashboard `FindRunLocationResult`:
  - `found` — exactly one definitive, strictly-decoded match bound to the probed org
  - `not_found` — every probe a definitive documented 404 body
  - `auth` — 401/403 (or orgs-list auth failure)
  - `unavailable` — network/abort, malformed/extra/wrong-domain body, unexpected
    2xx, 5xx, partial outage, or multi-match

## Negative controls

- Mismatched project org (including privileged actor) → 404, never a location.
- Malformed/extra/wrong-domain 200 bodies → client `unavailable`, not found.
- Network/abort, 401/403, 5xx, invalid 404 body, partial outage → never
  `not_found`.
- Multi-match (two orgs 200) → `unavailable` / ambiguous.
- Request log proves no `/projects` or project run-list fan-out on the location path.

## Validation

- Focused: `runLocation.route.test.ts`, `findRunLocation.test.ts`, run-detail /
  recovery / SSE render suites that exercise the real route surface.
- Bound SQL params: location summary query is exactly `[runId, orgId]`.
- Line counts under 500; architecture/format/lint/typecheck on affected packages.

## Serialization

Do not parallel-edit shared `orchestrator.ts`, `runs/contract.ts`, or
`runRoutesPool.ts` until this card merges or explicitly hands off.
