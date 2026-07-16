# in-1 — Integration lifecycle data model + RLS

**Node:** `in-1`
**Bucket:** integrations / MVP
**Consumes:** SP-1 immutable behavior revisions
**Provides to:** `in-3`, `in-4`, `in-5`, `in-9`–`in-11`, `in-14`, `in-16`–`in-22`

## Outcome

Install the one Postgres authority for the integration lifecycle. Clean-replace the
single-provider `org_integrations` registry with separately versioned connections
and grants, give `project_app_env` a direct tenant/environment/generation identity,
and add the durable requirement, capability, binding, reconciliation, delivery,
and validation entities required by the downstream integration nodes.

Every lifecycle table carries mandatory, indexed `org_id`, composite tenant-aware
foreign keys, and forced deny-by-default RLS. No compatibility view, backfill,
dual-write, or legacy table remains.

### P1 Slice 1 (this unit)

Verified provider principals, immutable auth/grant generations, one eligibility
authority, and the complete future binding/delivery/greenfield relational shape
folded into the still-unmerged migration `0041` (no `0042`). Link/rotate/eligibility
activate completely; binding workers remain schema-only for later slices.

## Owned paths

Exclusive (P1 Slice 1):

- `docs/roadmap/mission-complete/nodes/cards/integration-lifecycle-data-model.md`
- `db/migrations/0041_integration_lifecycle.sql`
- `db/migrations/meta/0041_snapshot.json`
- `db/migrations/meta/_journal.json` (single 0041 entry only)
- `db/src/schemaIntegrationConnections.ts`
- `db/src/schemaIntegrationRequirements.ts`
- `db/src/schemaIntegrationBindings.ts`
- `db/src/schemaProjectDerivations.ts`
- `db/src/schemaIntegrationOperations.ts`
- `db/src/schemaIntegrationEnvironment.ts`
- `db/src/schemaIntegrationPolicy.ts`
- `db/src/schemaIntegrationSelection.ts`
- `db/src/schemaSpineReferences.ts`
- the minimal integration exports in `db/src/schema.ts`
- the tenant-key indexes / lifecycle enum in `db/src/schemaCore.ts` (projects.lifecycle)
- `services/orchestrator/src/engine/contracts/integrationAuthority.ts`
- `services/orchestrator/src/engine/contracts/integrationSecretStore.ts`
- `services/orchestrator/src/engine/contracts/integrationCatalog.ts`
- `services/orchestrator/src/engine/integrations/principalVerifiers.ts`
- `services/orchestrator/src/engine/integrations/integrationAuthorityImpl.ts`
- `services/orchestrator/src/engine/integrations/integrationSecretStoreImpl.ts`
- `services/orchestrator/src/engine/repositories/integrationConnections.ts`
- `services/orchestrator/src/engine/repositories/integrationLifecycleInventory.ts`
- `services/orchestrator/src/engine/repositories/integrationProjectAccess.ts`
- `services/orchestrator/src/engine/repositories/integrationQuery.ts`
- `services/orchestrator/src/routes/integrations/index.ts`
- `services/dashboard/src/api/integrations.ts`
- `services/dashboard/src/api/integrationsClient.ts`
- `services/dashboard/src/components/integrations/**`
- `services/dashboard/src/routes/integrations/index.tsx`
- `services/orchestrator/tests/integrationLifecycleModel.test.ts`
- `services/orchestrator/tests/integrationLifecycleRls.integration.test.ts`
- `services/orchestrator/tests/integrationLifecycleMigrationOrder.integration.test.ts`
- `services/orchestrator/tests/integrationAuthority*.test.ts`
- `services/orchestrator/tests/integrationPrincipal*.test.ts`
- `services/orchestrator/tests/integrationRoutes.contract.test.ts`
- `services/orchestrator/tests/helpers/integrationMemoryDb.ts` (delete SQL-string matcher)
- `services/dashboard/tests/integrations.render.test.ts`

Integration-specific cutover paths (preserve P0 callers while replacing authority):

- `services/orchestrator/src/engine/repositories/index.ts`
- `services/orchestrator/src/engine/repositories/appEnvironment.ts`
- `services/orchestrator/src/engine/repositories/organizations.ts`
- `services/orchestrator/src/engine/contracts/repositories.ts`
- `services/orchestrator/src/engine/contracts/integrationProvisioner.ts`
- `services/orchestrator/src/engine/integrations/provisioningEngine.ts`
- `services/orchestrator/src/engine/providers/sentryProvisioner.ts`
- `services/orchestrator/src/engine/postMerge/demoOnDeploy.ts`
- `services/orchestrator/src/engine/postMerge/deployOnMerge.ts`
- `services/orchestrator/src/engine/postMerge/deployTargetResolution.ts`
- `services/orchestrator/src/routes/projects/greenfield.ts`
- `services/orchestrator/src/routes/projects/greenfieldDeployAuthority.ts`
- `services/orchestrator/src/routes/projects/greenfieldDeployDestroy.ts`
- `services/orchestrator/src/routes/onboarding/index.ts`
- `services/orchestrator/src/engine/forge/interview/deployDependency.ts`
- `services/orchestrator/src/engine/forge/interview/derive.ts`
- `services/orchestrator/src/engine/forge/interview/deriveCompensation.ts`
- `services/orchestrator/src/engine/forge/interview/engine.ts`
- `services/orchestrator/src/engine/forge/interview/index.ts`
- `services/orchestrator/src/engine/workflow/resolveAppEnv.ts`
- `services/orchestrator/src/engine/workflow/attachRuntimeAppEnv.ts`
- `services/orchestrator/src/engine/worker/runExecutor.ts`
- related tests for the cutover paths above

Deleted (do not reintroduce):

- `db/src/schemaIntegrationLifecycle.ts` (split; no compatibility re-export)
- `db/src/schemaIntegrations.ts`
- `services/orchestrator/src/engine/repositories/orgIntegrations.ts`
- `credentialRefForIntegrationAccount` stable-path helper
- incomplete `listControlGrants` / `resolveControlGrant` as eligibility authority
- naked credential refs in grant outputs
- SQL-string-matching `integrationMemoryDb`
- caller-supplied policy/consent revisions and `manual-link.v1` fallback
- `delivery_runs.binding_generations` JSON authority

Explicitly not owned: the SP-8 event registry/generated event schemas (`in-3`),
dashboard navigation/`screens.ts` (`in-21`), `main.ts`, or MergeAuthority files.
No migration `0042`.

## Durable model (P1)

### Connections / grants / operations

- **Stable** `org_integration_connections`: verified principal identity
  (`provider_principal_id`, `principal_kind`, sanitized display/metadata),
  `provider_kind`, lifecycle/health, `current_auth_generation`. No credential ref,
  auth kind, expiry, or caller metadata on the stable row.
- **Immutable** `org_integration_connection_auth_generations` keyed exactly by
  `(org_id, provider_kind, connection_id, generation)`.
- **Durable** `org_integration_connection_operations` for link/rotation stages,
  idempotency, failure/compensation, and candidate selection.
- **Stable** `org_integration_grants`: provider+connection identity, current
  generation, coarse lifecycle.
- **Immutable** `org_integration_grant_generations` keyed by
  `(org_id, provider_kind, connection_id, grant_id, generation)` carrying
  capabilities, operations, scopes, typed constraints, policy/consent revisions,
  expiry, and lifecycle.
- **Project selections** pin exact auth and grant generations with exact FKs.
  Currentness is an eligibility rule, not a denormalized secret.

Stable provider principals: Slack `team_id`, Sentry organization stable ID,
Vercel team ID or user ID, Fly organization ID. Multi-principal credentials enter
`awaiting_principal_selection` and never guess. Linking a credential that resolves
to an already-linked principal conflicts; only authenticated rotate advances
generation.

### Requirements / bindings / delivery / greenfield

- Composite requirement/spec/project/provider/grant lineage uniques.
- `capability_nodes` references exact `(org_id, project_id, requirement_id)` lineage.
- Stable `integration_bindings` + `integration_binding_generations` keyed by exact
  org/project/requirement/environment/binding/generation and carrying exact
  provider/connection/auth/grant generations, resource evidence, ownership/teardown,
  hashes, status/drift.
- Exact-generation `integration_binding_env`; provisioned `project_app_env` rows FK
  the complete binding-output tuple. No fake `dev` bypass for provisioned rows.
- Reconciliations/snapshots carry exact binding generation/lineage.
- `delivery_run_bindings` with exact project/run/binding-generation FKs (no JSON
  `binding_generations` authority).
- Validation proofs FK exact project/spec/requirement/binding generation and the
  exact delivery binding set.
- Project lifecycle supports `deriving | active | archived`; forced-RLS
  `project_derivations` with idempotency fingerprint, phase/status, sanitized
  resumable input/error, template/result/ownership receipts.
- Ownership/teardown and ready/resource invariants enforced in checks.
- Every new table: direct indexed `org_id`, tenant-aware FKs, deny-by-default RLS,
  FORCE RLS.

### Canonical authority (activated this slice)

`IntegrationAuthority` is the only entry point before normal integration secret
reads or provider construction:

- `authorizePrincipalVerification` — narrow permit after org-admin auth + durable
  operation creation.
- `authorizeOperation` — one repository query validating lineage, current
  generations, health, expiry, capability, operation, scopes, constraints, policy,
  and consent; returns an opaque eligible-operation lease.

Generation-addressed integration secret store (`stage` / `finalize` / `getExact` /
`compensate`) — immutable generation paths, Vault KV CAS create-only, never
overwrites an active coordinate.

## Callable and visible slice

Authenticated org admin link/rotate returns `202` with sanitized operation URL/state.
Principal-selection resumes multi-principal credentials. Inventory shows verified
principal, health, expiry, current generations, operation state, and ineligibility
reasons — never credential refs/tokens. UI removes account/workspace ID input and
never echoes submitted tokens. Events append only through the canonical EventStore.

## Verification

- Schema contract: all P1 tables, direct `org_id`, composite tenant FKs, enum/digest
  checks, forced RLS, absence of legacy authorities.
- Fresh empty PostgreSQL applies `0000→0041` with every new prerequisite unique
  before FK (migration-order proof).
- Real-Postgres RLS + same-org cross-project/provider/grant/generation/binding
  attack rejection.
- Former-bug proofs: caller-labelled identity rejected; multi-principal never guessed;
  stage/verify/finalize/commit failures leave old generation current; concurrent
  rotations produce one current generation; eligibility negatives assert zero
  `getExact` / provider construction / provider call.
- Live-gated Vault and provider proofs when credentials present.
- HTTP auth/sanitization/candidate-selection/idempotency; UI pending/failure/verified
  principal rendering.

## P0/P1 convergence redrive (post-audit)

Independent audit returned hard NO-GO on dual/broken authority. Slice 1 now
closes the following with production cutover (still not full IN-1 completion):

| P0                       | Closure                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Eligibility bypasses     | Production provider I/O uses only `authorizeOperation` after exact project selection. Deleted `resolveExactControlGrant` + sole-candidate `candidates[0]` + fabricated leases. Greenfield/demo/destroy reordered behind project+selection. |
| Verified scopes          | Slack scopes from `x-oauth-scopes`; Sentry from capability probes; principal-select persists verified scopes (never `[]` hardcode). Unproven scopes fail before finalize.                                                                  |
| Exact generation secrets | Sentry/Slack/deploy provisioners + deploy adapters read via `secretValueForLease` / `getExact` only.                                                                                                                                       |
| Secret finalization saga | Reserve connection+generation in DB → create-only secret write → pointer flip only if op owns reservation. Completed idempotent link replay returns terminal result.                                                                       |
| Multi-principal UI       | Dashboard CSRF form over durable candidates + operation id (`/integrations/select-principal`). No generation display.                                                                                                                      |
| PG/RLS proof             | Live-gated tests seed real 0041 rows (no deleted APIs). Memory fake is unit-contract only, not SQL/RLS proof. Opt-in: `TANREN_RLS_DB_TEST=1`.                                                                                              |

**Not claimed:** full IN-1 node completion, binding workers, 0042, shared smoke.

### Live obligations (skipped when credentials/DB absent)

- Real PG: `TANREN_RLS_DB_TEST=1` + `DATABASE_URL` → RLS + migration-order tests.
- Live Vault CAS create-only + live Slack/Sentry/Vercel/Fly principal verification when provider credentials present.
- Architecture former-bug greps in `integrationAuthority.p0.convergence.test.ts`.

## Gate

`just affected-typecheck`, `just affected-test`, architecture/contract/schema drift,
`just fast-check`, `just ci`. Shared `just smoke` is serialized by root after
independent audit. Do not claim IN-1 node completion until Slice 2/3 land binding
activation and remaining cutover.
