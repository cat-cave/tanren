# in-2 — typed integration lifecycle contracts

**Phase**: MVP consumer (integrations)
**Node ID**: `in-2` (in `CONSUMER`)
**Base**: `origin/main` @ `67d9363fe220e1f280ed706a0b80af2b16724362`
**Predecessors**: SP-1, SP-3, and EV-SUB-W0 / migration `0042`
**State**: **COMPLETE CANDIDATE** — the contracts, durable CAS path, callable
HTTP surface, visible overview panel, governed producer, and non-mocked apex
proof are implemented. Node credit starts only after gates, audit, and merge.

## Purpose

Freeze a strict, versioned, sole compile target for integration **documents**:

- `IntegrationRequirementV1`
- behavior stimulus + expected `IntegrationEffectContractV1`
- provider policy, plane, direction, environments, required operations/scopes
- `AppBindingOutputV1`
- `IntegrationValidationPlanV1`

Plane separation is mechanical: a Plane-A control Slack notification credential
shape **must never** validate as a product messaging binding.

## Dependencies

**Hard**

- SP-1: `engine/contracts/behaviorRevision.ts` (stimulus can cite behavior revision ids)
- SP-3: `engine/contracts/cas.ts` — sole `Digest` / `domainHash` / `CasByteStore`
- Migration `0035_cas_proof_substrate` (`cas_artifacts` + forced RLS) — **no new table**

**Not waiting on**

- IN-1 lifecycle tables / `0041`, provisioners, `routes/integrations/**`, #856

## Exclusive ownership

- `docs/roadmap/mission-complete/nodes/cards/in-2.md`
- `services/orchestrator/src/engine/contracts/integrationRequirement.ts`
- `services/orchestrator/src/engine/contracts/integrationEffect.ts`
- `services/orchestrator/src/engine/contracts/integrationBindingOutput.ts`
- `services/orchestrator/src/engine/cas/pgCasByteStore.ts` (minimal `CasByteStore` adapter)
- `services/orchestrator/src/routes/integrationContracts/index.ts`
- `services/dashboard/src/api/integrationContracts.ts`
- `services/dashboard/src/components/integrations/IntegrationContractPanel.tsx`
- `services/orchestrator/tests/integrationRequirement.golden.test.ts`
- `services/orchestrator/tests/integrationContracts.route.test.ts`
- `services/orchestrator/tests/integrationContracts.apex.integration.test.ts`
- `services/orchestrator/tests/pgCasByteStore.rls.integration.test.ts`
- `services/dashboard/tests/integrationContracts.render.test.ts`

## Shared-resource leases (minimal wire only)

- `services/orchestrator/src/engine/contracts/cas.ts` — additive domain tag
  `integration_requirement.v1` only (compatible consumer extension of SP-3 registry;
  not a second Digest/hash family)
- `services/orchestrator/src/engine/contracts/index.ts` — re-export the three contract modules
- `services/orchestrator/src/routes/behaviors/index.ts` — one registration of
  `registerIntegrationContractRoutes` (free parent under `/orgs`; **not**
  `routes/integrations/**`, **not** `mountFeatureRoutes`)
- `services/dashboard/src/routes/overview/index.tsx` — fetch catalog + sample
  validates; pass panel props (free surface; **not** integrations screen / nav)
- `services/dashboard/src/components/overview/OverviewBody.tsx` — render
  `<IntegrationContractPanel />` only

## Forbidden paths

- Any migration / journal / snapshot
- `routes/integrations/**`, `IntegrationsBody.tsx`, provisioning/lifecycle schemas
- Event registry / seed / sensitivity
- Project config CAS, MergeAuthority, `mountFeatureRoutes`, postMerge
- Global nav / screens.ts / main.ts / routes.ts
- Active foreign worktree paths (IN-1, RV-4, GV-\*, MQ-1, #856)

## Consumes

- SP-3 `domainHash` / `parseDigest` / `CasByteStore` / `CasArtifactRef`
- Existing `cas_artifacts` (0035) under `runWithOrgScope` + forced RLS
- `actorCanAccessOrg` for HTTP authz
- SP-1 vocabulary only as optional stimulus reference ids (no SP-1 table writes)

## Produces

### Contracts

Strict Zod + static types for the document family above; stable golden vectors for:

1. product `messaging.send` (Slack product plane) — accepts
2. control `control.notify` (Plane-A) — accepts
3. control credential shape claimed as product messaging — **rejects**
4. forbidden provider / missing effect / empty scopes — **rejects**

### CAS

- Domain tag extension: `integration_requirement.v1` on SP-3 `DOMAIN_TAGS`
- `requirementDigest = domainHash("integration_requirement.v1", canonicalBody)`
- Successful validate **puts** canonical JSON bytes into org-scoped `cas_artifacts`
  via `PgCasByteStore` (media type
  `application/vnd.tanren.integration-requirement.v1+json`)
- Response returns both semantic digest and durable `CasArtifactRef` — never
  secret values

### HTTP

Mounted under free parent `/orgs` (via behaviors thin wire):

| Method | Path                                     | Result                                                                                         |
| ------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST` | `/:orgId/integration-contracts:validate` | `200` ok + digests + artifact; `422` validation errors; `400` malformed body; `403` org denied |
| `GET`  | `/:orgId/integration-contracts/catalog`  | plane/capability/binding-kind discriminators + mission node id                                 |

`missionNodeId: "in-2"` on all success bodies.

### UI

`IntegrationContractPanel` on **overview** (not integrations screen):

- Live catalog discriminators
- Live validate outcomes for product / control / cross-plane-negative samples
- Loud unavailable / auth / malformed states — no decorative success cosplay

### Named event proof (COMPLETE)

EV-SUB-W0 landed migration `0042` and the strict governed schema for:

- proof event: `integration.requirement.validated`
- payload identity: requirement digest + verified CAS artifact identity

The persisting validate route appends it through the sole `PgEventStore` only
after `PgCasByteStore.put` returns its integrity-verified stored winner. The
real-Postgres apex test proves HTTP → event → retrievable/rehashed bytes, stable
CAS identity across revalidation, and cross-org denial. Preview, invalid,
malformed, and denied requests emit nothing and produce no CAS write.

### Convergence fixes (R1–R4 closed)

Independent convergence audit `in2-b5edc573-grok-convergence-report.md` ranked
the named-event/apex gap (R1) as the original P0. The bounded remediation
touches only owned/shared paths above:

- **R1 — governed event + apex correlation**
  (`routes/integrationContracts`, route unit proof, real-PG apex proof): exactly
  one append follows each successful persisting CAS put; event and response
  reference the same stored artifact. Non-persisting and failure paths append
  zero events. EV-SUB-W0 owns the catalog/schema/migration; IN-2 owns only the
  consumer emit.

- **R2 — CAS adapter truth/integrity** (`pgCasByteStore.ts`, `cas.ts`):
  `put` returns the STORED winner's media type/byte size (re-read after
  insert-or-conflict); stored bytes are re-hashed to the requested digest on
  put/read and corruption raises a typed `CasArtifactIntegrityError`. Real-PG
  RLS proof extended: same-bytes/different-media-type stored-winner, corruption
  detection, same-org positive, cross-org denial/zero effects.
- **R3 — live UI without write-on-read** (`routes/integrationContracts`,
  dashboard api + overview + panel): explicit `persist` flag (default `true`
  for real callers; `false` still runs full parse + both digests but performs NO
  CAS write). Overview samples use `persist: false`; response honestly reports
  `persisted` state. Route/render tests prove samples cause zero CAS puts while
  normal validation persists exactly once/idempotently.
- **R4 — canonical contract hardening** (`integrationRequirement.ts`,
  `integrationBindingOutput.ts`, `cas.ts`): `secret_ref` requires an explicitly
  ref-shaped/allowlisted kind (bare `_id` rejects); set-semantic arrays
  (environments / requiredOperations / requiredScopes) canonicalize to
  sorted-unique order before hashing without mutating caller input; the private
  canonical-JSON duplication was eliminated by reusing the exported sole SP-3
  `canonicalJson`; pinned full-hex golden digests + byte lengths plus
  permutation/duplicate/version/extra-field coverage.

## Validation

- Golden contract vectors (always-on)
- Route unit tests (authz, 422 plane separation, CAS put path mocked/in-memory ok)
- Real-PG apex: HTTP validate → governed event → matching retrievable CAS bytes;
  cross-org and no-effect negative controls
- Real-PG RLS: same-org put/get; cross-org denied (`TANREN_RLS_DB_TEST=1`)
- Dashboard render test: panel shows live result markers + unavailable branch
- `just affected-typecheck` + `just affected-test`
- Formatter + `git diff --check` + line-cap recount (all owned files ≤500)

## Line-cap plan

| File                                      | Concern                                                           |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `integrationEffect.ts`                    | stimulus + effect schemas                                         |
| `integrationBindingOutput.ts`             | binding output + plane kinds                                      |
| `integrationRequirement.ts`               | requirement + validation plan + semantic rules + digest + catalog |
| `pgCasByteStore.ts`                       | sole SP-3 adapter over `cas_artifacts`                            |
| `routes/integrationContracts/index.ts`    | HTTP only                                                         |
| `IntegrationContractPanel.tsx`            | presentation only                                                 |
| `integrationContracts.ts` (dashboard api) | client decode + fetch                                             |

One concern per file; no shims; delete any superseded alternate path introduced here.
