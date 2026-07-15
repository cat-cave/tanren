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

## Owned paths

Exclusive:

- `docs/roadmap/mission-complete/nodes/cards/integration-lifecycle-data-model.md`
- `db/src/schemaIntegrationLifecycle.ts`
- `db/src/schemaIntegrationOperations.ts`
- `services/orchestrator/src/engine/repositories/integrationConnections.ts`
- `services/orchestrator/src/engine/repositories/integrationLifecycleInventory.ts`
- `services/orchestrator/tests/integrationLifecycleModel.test.ts`
- `services/orchestrator/tests/integrationLifecycleRls.integration.test.ts`

Integration-specific cutover paths:

- `db/src/schemaIntegrations.ts` (delete after callers use the new modules)
- `services/orchestrator/src/engine/repositories/orgIntegrations.ts` (delete)
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
- `services/orchestrator/src/routes/projects/greenfieldDeployDestroy.ts`
- `services/orchestrator/src/engine/workflow/resolveAppEnv.ts`
- `services/orchestrator/src/engine/workflow/attachRuntimeAppEnv.ts`
- `services/orchestrator/src/engine/worker/runExecutor.ts`
- `services/orchestrator/src/routes/integrations/index.ts`
- `services/orchestrator/tests/integrationProvisioningEngine.test.ts`
- `services/orchestrator/tests/integrationRoutes.contract.test.ts`
- `services/orchestrator/tests/conformance/integrationRepositories.conformance.test.ts`
- `services/orchestrator/tests/appEnvInjection.test.ts`
- `services/orchestrator/tests/attachRuntimeAppEnv.test.ts`
- `services/orchestrator/tests/resolveAppEnv.test.ts`
- `services/orchestrator/tests/demoOnDeploy.test.ts`
- `services/orchestrator/tests/demoOnDeployAdapterDispatch.test.ts`
- `services/orchestrator/tests/deployOnMerge.test.ts`
- `services/orchestrator/tests/greenfieldDeployRequiredRoutes.test.ts`
- `services/dashboard/src/api/integrations.ts`
- `services/dashboard/src/api/integrationsClient.ts`
- `services/dashboard/src/components/integrations/IntegrationsBody.tsx`
- `services/dashboard/src/components/integrations/format.ts`
- `services/dashboard/src/components/integrations/styles.ts`
- `services/dashboard/src/routes/integrations/index.tsx`
- `services/dashboard/tests/integrations.render.test.ts`

Serialized and reserved by the root orchestrator exclusively for this node:

- `db/migrations/0041_integration_lifecycle.sql`
- `db/migrations/meta/0041_snapshot.json`
- `db/migrations/meta/_journal.json`
- the minimal integration exports in `db/src/schema.ts`
- the tenant-key indexes in `db/src/schemaCore.ts`

Explicitly not owned: the SP-8 event registry/generated event schemas (`in-3`),
dashboard navigation/`screens.ts` (`in-21`), `main.ts`, or MergeAuthority files.

## Durable model

The migration owns these tables:

- `integration_requirements`
- `behavior_integration_requirements`
- `capability_nodes`
- `capability_node_dependencies`
- `spec_capability_dependencies`
- `org_integration_connections`
- `org_integration_grants`
- `integration_bindings`
- `integration_binding_env`
- `project_app_env` (clean replacement of the old shape)
- `integration_reconciliations`
- `integration_resource_snapshots`
- `delivery_runs`
- `delivery_stage_attempts`
- `integration_validation_proofs`

All identities are unique as `(org_id, id)` so every cross-entity reference can
include `org_id`. Desired-state and evidence digests use the canonical SP-3
`sha256:<64 lowercase hex>` format where applicable. Lifecycle enums are enforced
with database checks. Secrets remain opaque references; no secret value or raw
provider body is stored.

The old `org_integrations` table is dropped. Current control-plane linking creates
one connection plus its explicit `control` grant in a single database statement,
and every caller reads through that new store. The old one-row-per-provider
authority is not retained behind an alias.

## Callable and visible slice

`in-20` still owns the full lifecycle HTTP API and `in-21` owns the complete
Control Center. This foundation node extends the existing authenticated
`GET /orgs/:orgId/integrations` read with a sanitized lifecycle inventory:
connections and grants plus requirement/capability/binding/delivery counts for the
selected project. The existing Integrations screen renders that inventory. It
never returns credential refs, provider bodies, or secret values.

The live node proof uses the existing named `integration.provisioned` event while
the provision path resolves its authority from the new connection+grant model.
`in-3` later expands the vocabulary; this node does not bypass SP-8 serialization.

## Verification

- Schema contract test asserts all 15 tables, direct `org_id`, composite tenant
  FKs, enum/digest/XOR checks, forced RLS, and absence of `org_integrations`.
- Real-Postgres test applies migrations and proves unset-org reads return zero,
  same-org reads succeed, cross-org reads return zero, and cross-org FK/write
  attempts fail. It covers both lifecycle rows and `project_app_env`.
- Route contract proves auth, project membership, sanitized output, and project
  scoping; credential refs never appear in JSON.
- Dashboard render proof shows truthful lifecycle counts/status and preserves a
  loud error state instead of fake zeroes.
- Named-event proof provisions through the new connection+grant authority and
  observes `integration.provisioned`.
- Mutation-negative control deliberately supplies a foreign-org connection/grant
  or binding reference and requires the database to reject it. Removing either
  the tenant-aware FK or org scope makes the test fail.

## Gate

Run narrow affected typecheck/tests during authoring, the real-Postgres RLS test,
then `just fast-check`, `just ci`, and `just smoke` before handoff. No result is
reported green unless the new tables and the new connection/grant path are the
ones actually exercised.
