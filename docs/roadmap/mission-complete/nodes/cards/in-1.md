<!-- cspell:ignore schemaIntegration schemaSpine deriving reconciliations -->

# in-1 — integration lifecycle data model + RLS foundation

**Phase**: MVP (integrations)
**Node ID**: `in-1`
**Base**: `origin/main` @ `d39369ec2788a7094c9a714dd7935e7fcbea5b0e` (#965 IN-7 spec-freeze W1-A)
**Branch**: `mission/in-1-final-fold`
**Node credit (this branch)**: **0** until independent audit + green gates + merge
**Purpose**: lay the **tenant-safe integration lifecycle FOUNDATION** every downstream
integrations node (in-2..22) builds on — the `integration_*` / capability / delivery
data model in migration `0043`, RLS org-scoping on every new table, the typed
`db/src/schemaIntegration*.ts` schema surface, the orchestrator integration
contracts + provisioning/authority engine wiring, and the dashboard
integrations/inbox visibility that renders the lifecycle state. This is the
**largest node in the program by far** — ~383 non-doc files (388 total, +45.5k/-8.5k),
because it establishes the whole vocabulary and the persisted/RLS backbone the rest
of the MVP consumes rather than redefines. Flag the size honestly: it is a
foundation slab, not an incremental feature, and it touches broadly across the
orchestrator to make the new model live end-to-end (forge derivation, DAG, routes,
repositories, post-merge delivery).

## Consumes (do not redefine)

| Dependency                                                      | Status on this base                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| SP·1 behavior revisions (`behavior_revisions`)                  | on main — `behavior_integration_requirements` FK-references it         |
| Spine tenant lineage (`projects` / `specs` / `runs` / `events`) | on main — `0043` adds composite `(org_id, …)` lineage FKs, no reshape  |
| `db/src/schemaSpineReferences.ts` spine ref shapes              | consume + extend; do not fork the spine contract                       |
| `organizations` + `db/src/orgScope.ts` RLS scoping primitive    | on main — every new table ENABLEs RLS off the org-scoped client        |
| `integration_nodes` (jj-integrated source) vocabulary           | on main — capability nodes are a **distinct** concept; do not conflate |

**This node OWNS migration `0043`.** It is the integrations-program migration slot;
no downstream in-node may claim it. RLS-by-default is mandatory on every table it
creates — a query off the scoped client must see zero cross-org rows.

## Exact exclusive ownership

| Path                                                                                                                 | Role                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/roadmap/mission-complete/nodes/cards/in-1.md`                                                                  | this card                                                                                                                                                                                                |
| `db/migrations/0043_integration_lifecycle.sql`                                                                       | the integration lifecycle DDL + RLS + projects `deriving/active/archived` + spine lineage FKs                                                                                                            |
| `db/migrations/meta/0043_snapshot.json`, `db/migrations/meta/_journal.json`                                          | drizzle migration metadata for the `0043` slot                                                                                                                                                           |
| `db/src/schemaIntegrations.ts`                                                                                       | root integration schema surface                                                                                                                                                                          |
| `db/src/schemaIntegrationRequirements.ts`                                                                            | `integration_requirements` + `behavior_integration_requirements` + `capability_nodes` + `capability_node_dependencies` + `spec_capability_dependencies`                                                  |
| `db/src/schemaIntegrationNodes.ts`                                                                                   | `integration_nodes` + `integration_proofs` (the jj integration-nodes run model)                                                                                                                          |
| `db/src/schemaIntegrationConnections.ts`                                                                             | `org_integration_connections` + auth/operation generation tables                                                                                                                                         |
| `db/src/schemaIntegrationPolicy.ts`                                                                                  | `org_integration_grants` + grant generations + selections                                                                                                                                                |
| `db/src/schemaIntegrationSelection.ts`                                                                               | `project_integration_grant_selections`                                                                                                                                                                   |
| `db/src/schemaIntegrationBindings.ts`                                                                                | `integration_bindings` + binding generations + `integration_binding_env`                                                                                                                                 |
| `db/src/schemaIntegrationOperations.ts`                                                                              | delivery + reconciliation tables (`delivery_runs`, `delivery_run_bindings`, `delivery_stage_attempts`, `integration_reconciliations`, `integration_resource_snapshots`, `integration_validation_proofs`) |
| `db/src/schemaIntegrationEnvironment.ts`                                                                             | `project_app_env` scoped runtime env / secret-ref projection                                                                                                                                             |
| `db/src/schemaProjectDerivations.ts`                                                                                 | `project_derivations` (deriving-shell lifecycle)                                                                                                                                                         |
| `services/orchestrator/src/engine/contracts/integration*.ts`                                                         | `integrationAuthority` / `integrationCatalog` / `integrationProvisioner` / `integrationSecretStore` typed contracts                                                                                      |
| `services/orchestrator/src/engine/integrations/**`                                                                   | provisioning engine + persistence, authority impl/eligibility/validation, secret store + cleanup reaper, principal verifiers, slack provisioner/transport                                                |
| `services/orchestrator/src/routes/integrations/**`                                                                   | integration HTTP surface — link saga, principal selection/verifier, authority payloads/writes, public link-op status                                                                                     |
| `services/orchestrator/src/routes/inbox/**`                                                                          | inbox route surface for integration/link outcomes                                                                                                                                                        |
| `services/dashboard/src/components/integrations/**`, `src/routes/integrations/index.tsx`, `src/api/integrations*.ts` | dashboard integrations visibility (body, format, styles, typed BFF client)                                                                                                                               |
| `services/dashboard/src/components/inbox/InboxBody.tsx`, `src/routes/inbox/index.tsx`, `src/api/inbox*.ts`           | dashboard inbox visibility for link outcomes                                                                                                                                                             |
| `services/orchestrator/tests/**` (integration/provisioning/authority/lifecycle suites)                               | unit + migration-order + RLS integration proofs for the above                                                                                                                                            |
| `services/dashboard/tests/integrations.*.render.test.ts`, `inbox.render.test.ts`                                     | dashboard render proofs                                                                                                                                                                                  |

Where a group is too large to enumerate (383 non-doc files), ownership is by
**directory** as listed above; the concrete non-negotiable claims are the `0043`
migration slot and the `db/src/schemaIntegration*.ts` + `schemaProjectDerivations.ts`
schema group.

## Soft leases (thin wire only — no ownership expansion)

| Path                                                                                      | Allowed edit                                                                                  |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `db/src/schema.ts`                                                                        | export the new `schemaIntegration*` / `schemaProjectDerivations` modules only                 |
| `db/src/schemaCore.ts`                                                                    | add the `projects.lifecycle` `deriving/active/archived` shape only                            |
| `db/src/schemaSpineReferences.ts`, `schemaEvents.ts`, `schemaInbox.ts`                    | wire spine lineage FK references + inbox link rows; no spine reshape                          |
| `services/orchestrator/src/engine/forge/**`                                               | compile the integration requirement from Forge G/W/T + deriving-shell flip; no forge redesign |
| `services/orchestrator/src/engine/dag/**`, `engine/contracts/dagWalker.ts`                | route capability-prepare nodes as a distinct kind; DagWalker stays a scheduler                |
| `services/orchestrator/src/engine/postMerge/**`                                           | insert the durable delivery run/outbox row on authorized land; no new merge authority         |
| `services/orchestrator/src/engine/repositories/**`                                        | add integration repository access behind the existing `Repositories` seam                     |
| `services/orchestrator/src/engine/merge/**`, `engine/deploy/**`, `engine/provisioners/**` | consume bindings/env; do not fork MergeAuthority or the deploy adapter                        |
| `services/orchestrator/src/mountRootApiRoutes.ts`, `main.ts`, `inputSchemas.ts`           | mount integration/inbox routes + input schemas only                                           |
| `services/dashboard/src/components/onboarding/new/ArrivalStep.tsx`                        | surface deriving-shell arrival state only                                                     |
| `ROADMAP.md`, `justfile`, `cspell.json`                                                   | roadmap note + recipe/dictionary housekeeping only                                            |

## Hard exclusions

- Any other integrations-program migration slot (each in-node owns its own; `0043` is in-1's)
- `integration_nodes` jj source-content vocabulary (distinct from capability nodes — do not conflate)
- Forking MergeAuthority, the `CodeHost` seam, or the deploy adapter to add an "integration merger"
- Any new-table site that omits RLS org-scoping (RLS-by-default is mandatory)
- Downstream in-2..22 contract shapes (this node founds the data model; it does not implement their features)
