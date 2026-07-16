# in-2 — typed integration lifecycle contracts

**Phase**: MVP consumer (integrations)  
**Node ID**: `in-2` (in `CONSUMER`)  
**Base**: `origin/main` @ `1f1eda2ed678f8ea7f12eef4a8362e22dbd39fee`  
**Predecessor**: SP-1 only (`behaviorRevision` substrate on main; no IN-1 / 0041)  
**State**: **NOT COMPLETE** — exclusive contract/HTTP/UI/CAS slice can land, but
the named-event / catalog lease is unavailable. Do **not** PR/merge/count until
the serialized event lease adds the exact IN-2 proof event + final apex assertion.

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

### Named event proof (BLOCKED)

**Unavailable under current event-registry lease.** Final completion requires a
later serialized event-lease PR to add exactly:

- proof event (proposed name, not seeded here): `integration.requirement.validated`
- apex assertion hook that the digest + CAS artifact identity fired live

Until then: node is **NOT COMPLETE**, not PR/merge/count eligible.

## Validation

- Golden contract vectors (always-on)
- Route unit tests (authz, 422 plane separation, CAS put path mocked/in-memory ok)
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
