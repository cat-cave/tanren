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

## Final cumulative fold scope

The final fold is one cumulative clean-replacement candidate from exact
`origin/main` (`9f20c3ea9a4d972a2564374abd16c63ed5f6fe87`). It is not a repair delta
layered on an undeclared branch. The manifest below is the machine-readable
ownership boundary for the lifecycle input, the intake/security input, and the
tenant/recovery convergence repair. Its path/status counts are frozen against the
final candidate only after the semantic fold is complete; no production or test
path may be edited before it appears here.

The manifest below is exhaustive for `origin/main...candidate`, including the
four deletions. No changed path may sit outside it. This remains a bounded P1
Slice 1 foundation: binding workers, rotation UI, the complete lifecycle event
surface, and the full callable/visible exercise remain downstream. Therefore the
strict number of fully completed consumer DAG nodes claimed by this PR is **0**.
That count cannot advance before exact-candidate independent audit, live proof,
CI, shared smoke, and hosted merge; even then, IN-1 remains incomplete until the
downstream binding activation and remaining cutover slices land.

### Exhaustive final-fold path manifest

<!-- final-freeze-manifest:start -->

- `ROADMAP.md`
- `cspell.json`
- `db/migrations/0041_integration_lifecycle.sql`
- `db/migrations/meta/0041_snapshot.json`
- `db/migrations/meta/_journal.json`
- `db/src/schema.ts`
- `db/src/schemaCore.ts`
- `db/src/schemaIntegrationBindings.ts`
- `db/src/schemaIntegrationConnections.ts`
- `db/src/schemaIntegrationEnvironment.ts`
- `db/src/schemaIntegrationOperations.ts`
- `db/src/schemaIntegrationPolicy.ts`
- `db/src/schemaIntegrationRequirements.ts`
- `db/src/schemaIntegrationSelection.ts`
- `db/src/schemaIntegrations.ts`
- `db/src/schemaProjectDerivations.ts`
- `db/src/schemaSpineReferences.ts`
- `docs/contracts/architecture-checks.md`
- `docs/design/hifi-work-needed.md`
- `docs/operator-guide/integration-provisioning.md`
- `docs/roadmap/mission-complete/nodes/cards/integration-lifecycle-data-model.md`
- `docs/roadmap/mission-complete/nodes/integrations.md`
- `justfile`
- `services/dashboard/src/api/integrations.ts`
- `services/dashboard/src/api/integrationsClient.ts`
- `services/dashboard/src/components/integrations/IntegrationsBody.tsx`
- `services/dashboard/src/components/integrations/format.ts`
- `services/dashboard/src/components/integrations/styles.ts`
- `services/dashboard/src/routes/integrations/index.tsx`
- `services/dashboard/tests/integrations.render.test.ts`
- `services/orchestrator/src/engine/contracts/awsSecretsManager.ts`
- `services/orchestrator/src/engine/contracts/gcpSecretManager.ts`
- `services/orchestrator/src/engine/contracts/integrationAuthority.ts`
- `services/orchestrator/src/engine/contracts/integrationCatalog.ts`
- `services/orchestrator/src/engine/contracts/integrationProvisioner.ts`
- `services/orchestrator/src/engine/contracts/integrationSecretStore.ts`
- `services/orchestrator/src/engine/contracts/onePassword.ts`
- `services/orchestrator/src/engine/contracts/repositories.ts`
- `services/orchestrator/src/engine/contracts/secretStore.ts`
- `services/orchestrator/src/engine/deploy/mobileReleaseDeployAdapter.ts`
- `services/orchestrator/src/engine/deploy/packageReleaseDeployAdapter.ts`
- `services/orchestrator/src/engine/deploy/pulumiDeployAdapter.ts`
- `services/orchestrator/src/engine/forge/audits/seedCatalog.ts`
- `services/orchestrator/src/engine/forge/interview/deployDependency.ts`
- `services/orchestrator/src/engine/forge/interview/deployIneligibleError.ts`
- `services/orchestrator/src/engine/forge/interview/derive.ts`
- `services/orchestrator/src/engine/forge/interview/deriveCompensation.ts`
- `services/orchestrator/src/engine/forge/interview/engine.ts`
- `services/orchestrator/src/engine/forge/interview/index.ts`
- `services/orchestrator/src/engine/integrations/integrationAuthorityImpl.ts`
- `services/orchestrator/src/engine/integrations/integrationOperationFingerprint.ts`
- `services/orchestrator/src/engine/integrations/integrationSecretCleanupReaper.ts`
- `services/orchestrator/src/engine/integrations/integrationSecretStoreImpl.ts`
- `services/orchestrator/src/engine/integrations/principalVerifierSupport.ts`
- `services/orchestrator/src/engine/integrations/principalVerifiers.ts`
- `services/orchestrator/src/engine/integrations/provisioningEngine.ts`
- `services/orchestrator/src/engine/integrations/slack/slackProvisioner.ts`
- `services/orchestrator/src/engine/notifications/seedDefaultRoute.ts`
- `services/orchestrator/src/engine/postMerge/demoOnDeploy.ts`
- `services/orchestrator/src/engine/postMerge/deployOnMerge.ts`
- `services/orchestrator/src/engine/postMerge/deployTargetResolution.ts`
- `services/orchestrator/src/engine/providers/sentryProvisioner.ts`
- `services/orchestrator/src/engine/provisioners/deployProvisioner.ts`
- `services/orchestrator/src/engine/repositories/appEnvironment.ts`
- `services/orchestrator/src/engine/repositories/index.ts`
- `services/orchestrator/src/engine/repositories/integrationConnectionActivate.ts`
- `services/orchestrator/src/engine/repositories/integrationConnectionCleanup.ts`
- `services/orchestrator/src/engine/repositories/integrationConnectionFinalize.ts`
- `services/orchestrator/src/engine/repositories/integrationConnectionFinalizeAssert.ts`
- `services/orchestrator/src/engine/repositories/integrationConnectionResolve.ts`
- `services/orchestrator/src/engine/repositories/integrationConnections.ts`
- `services/orchestrator/src/engine/repositories/integrationLifecycleInventory.ts`
- `services/orchestrator/src/engine/repositories/integrationOperationTransitions.ts`
- `services/orchestrator/src/engine/repositories/integrationProjectAccess.ts`
- `services/orchestrator/src/engine/repositories/integrationQuery.ts`
- `services/orchestrator/src/engine/repositories/orgIntegrations.ts`
- `services/orchestrator/src/engine/repositories/organizations.ts`
- `services/orchestrator/src/engine/repositories/projects.ts`
- `services/orchestrator/src/engine/worker/boot.ts`
- `services/orchestrator/src/engine/worker/runExecutor.ts`
- `services/orchestrator/src/engine/workflow/attachRuntimeAppEnv.ts`
- `services/orchestrator/src/engine/workflow/provisionAutonomousProject.ts`
- `services/orchestrator/src/engine/workflow/resolveAppEnv.ts`
- `services/orchestrator/src/routes/brownfield/fullTrack.ts`
- `services/orchestrator/src/routes/integrations/authorityPayloads.ts`
- `services/orchestrator/src/routes/integrations/authorityWrites.ts`
- `services/orchestrator/src/routes/integrations/index.ts`
- `services/orchestrator/src/routes/integrations/linkSaga.ts`
- `services/orchestrator/src/routes/integrations/principalSelectionRoute.ts`
- `services/orchestrator/src/routes/integrations/selectedPrincipalSaga.ts`
- `services/orchestrator/src/routes/integrations/verifierTransition.ts`
- `services/orchestrator/src/routes/onboarding/index.ts`
- `services/orchestrator/src/routes/projects/budget.ts`
- `services/orchestrator/src/routes/projects/governance.ts`
- `services/orchestrator/src/routes/projects/greenfield.ts`
- `services/orchestrator/src/routes/projects/greenfieldDeployAuthority.ts`
- `services/orchestrator/src/routes/projects/greenfieldDeployDestroy.ts`
- `services/orchestrator/src/routes/projects/greenfieldDeployPrepare.ts`
- `services/orchestrator/src/routes/projects/index.ts`
- `services/orchestrator/tests/appEnvInjection.test.ts`
- `services/orchestrator/tests/attachRuntimeAppEnv.test.ts`
- `services/orchestrator/tests/awsSecretsManager.test.ts`
- `services/orchestrator/tests/conformance/appEnvironment.conformance.test.ts`
- `services/orchestrator/tests/conformance/deployAdapter.conformance.test.ts`
- `services/orchestrator/tests/conformance/deployProvisioner.test.ts`
- `services/orchestrator/tests/conformance/deployProvisionerDestroyApp.test.ts`
- `services/orchestrator/tests/conformance/extendedDeployAdapter.conformance.test.ts`
- `services/orchestrator/tests/conformance/fakes/awsSecretsManagerFetch.ts`
- `services/orchestrator/tests/conformance/flyDeployReleaseConfig.test.ts`
- `services/orchestrator/tests/conformance/flyImageBuilder.test.ts`
- `services/orchestrator/tests/conformance/integrationConnections.conformance.test.ts`
- `services/orchestrator/tests/conformance/integrationProvisioner.conformance.test.ts`
- `services/orchestrator/tests/conformance/integrationRepositories.conformance.test.ts`
- `services/orchestrator/tests/conformance/manualExternalDeployAdapter.conformance.test.ts`
- `services/orchestrator/tests/conformance/mobileReleaseDeployAdapter.conformance.test.ts`
- `services/orchestrator/tests/conformance/packageReleaseDeployAdapter.conformance.test.ts`
- `services/orchestrator/tests/conformance/pulumiDeployAdapter.conformance.test.ts`
- `services/orchestrator/tests/conformance/repositories.conformance.test.ts`
- `services/orchestrator/tests/conformance/repositoriesConformance.ts`
- `services/orchestrator/tests/demoOnDeploy.test.ts`
- `services/orchestrator/tests/demoOnDeployAdapterDispatch.test.ts`
- `services/orchestrator/tests/deployOnMerge.test.ts`
- `services/orchestrator/tests/deployTransportRobustness.test.ts`
- `services/orchestrator/tests/deriveAtomicRollback.test.ts`
- `services/orchestrator/tests/deriveGreenfieldReattachGuard.test.ts`
- `services/orchestrator/tests/fixtures/forge/interviewDeriveStub.ts`
- `services/orchestrator/tests/gcpSecretManager.test.ts`
- `services/orchestrator/tests/greenfieldDeployRequiredRoutes.test.ts`
- `services/orchestrator/tests/helpers/greenfieldRoutes.ts`
- `services/orchestrator/tests/helpers/integrationMemoryActivate.ts`
- `services/orchestrator/tests/helpers/integrationMemoryDb.ts`
- `services/orchestrator/tests/helpers/integrationMemoryFinalize.ts`
- `services/orchestrator/tests/helpers/integrationMemoryOperations.ts`
- `services/orchestrator/tests/helpers/integrationMemoryQueries.ts`
- `services/orchestrator/tests/helpers/integrationMemoryTables.ts`
- `services/orchestrator/tests/helpers/orgGrant.ts`
- `services/orchestrator/tests/helpers/routesPool.ts`
- `services/orchestrator/tests/integrationAuthority.p0.convergence.test.ts`
- `services/orchestrator/tests/integrationAuthority.p1.test.ts`
- `services/orchestrator/tests/integrationAuthorityRaces.test.ts`
- `services/orchestrator/tests/integrationConnectionSaga.integration.test.ts`
- `services/orchestrator/tests/integrationConnectionSagaFailures.integration.test.ts`
- `services/orchestrator/tests/integrationLifecycleMigrationOrder.integration.test.ts`
- `services/orchestrator/tests/integrationLifecycleModel.test.ts`
- `services/orchestrator/tests/integrationLifecycleRls.integration.test.ts`
- `services/orchestrator/tests/integrationOperationDurability.integration.test.ts`
- `services/orchestrator/tests/integrationProvisioningEngine.test.ts`
- `services/orchestrator/tests/integrationRoutes.contract.test.ts`
- `services/orchestrator/tests/integrationVaultCas.integration.test.ts`
- `services/orchestrator/tests/integrations/slackProvisioner.test.ts`
- `services/orchestrator/tests/onePassword.test.ts`
- `services/orchestrator/tests/resolveAppEnv.test.ts`
- `services/orchestrator/tests/vercelDeployProvisionerPager.test.ts`
- `services/orchestrator/tests/workerBoot.test.ts`
- `services/orchestrator/src/engine/contracts/codeHost.ts`
- `services/orchestrator/src/engine/contracts/codeHostTypes.ts`
- `services/orchestrator/src/engine/contracts/dagWalker.ts`
- `services/orchestrator/src/engine/dag/walker.ts`
- `services/orchestrator/src/engine/dag/walkerPg.ts`
- `services/orchestrator/src/engine/design/designContract.ts`
- `services/orchestrator/src/engine/design/designPhase.ts`
- `services/orchestrator/src/engine/forge/interview/deriveBehaviorSpec.ts`
- `services/orchestrator/src/engine/forge/interview/deriveDesignContract.ts`
- `services/orchestrator/src/engine/forge/interview/deriveEntityGraph.ts`
- `services/orchestrator/src/engine/forge/interview/deriveProductGraph.ts`
- `services/orchestrator/src/engine/providers/githubCodeHost.ts`
- `services/orchestrator/src/engine/providers/githubRepoCreate.ts`
- `services/orchestrator/src/engine/repositories/projectDerivationReceipts.ts`
- `services/orchestrator/src/engine/repositories/projectDerivations.ts`
- `services/orchestrator/src/engine/templates/fragments/materialize.ts`
- `services/orchestrator/src/engine/workflow/projectCreate.ts`
- `services/orchestrator/src/engine/workflow/projectDerivationShell.ts`
- `services/orchestrator/src/engine/workflow/projectSpec.ts`
- `services/orchestrator/src/engine/workflow/projectSpecRowSchema.ts`
- `services/orchestrator/src/routes/onboarding/materializeTemplate.ts`
- `services/orchestrator/src/routes/projects/greenfieldCreateStateMachine.ts`
- `services/orchestrator/src/routes/projects/greenfieldRepoCreate.ts`
- `services/orchestrator/src/routes/projects/lifecycle.ts`
- `services/orchestrator/tests/conformance/conformanceMemoryDb.ts`
- `services/orchestrator/tests/conformance/dagWalker.conformance.test.ts`
- `services/orchestrator/tests/conformance/fakes/fakeRepoCreateHttp.ts`
- `services/orchestrator/tests/dagSpeculation.test.ts`
- `services/orchestrator/tests/dagWalkerAncestorNotReadyBackoff.test.ts`
- `services/orchestrator/tests/dagWalkerConcurrentTickTolerance.test.ts`
- `services/orchestrator/tests/dagWalkerPlan.test.ts`
- `services/orchestrator/tests/dagWalkerSpeculative.test.ts`
- `services/orchestrator/tests/fixtures/projectDerivationLifecycle.ts`
- `services/orchestrator/tests/greenfieldCreateIdempotency.test.ts`
- `services/orchestrator/tests/helpers/progressRoutesPool.ts`
- `services/orchestrator/tests/helpers/recoveryMemoryPool.ts`
- `services/orchestrator/tests/helpers/routesPoolDerivationEvidence.ts`
- `services/orchestrator/tests/helpers/routesPoolProjectDerivations.ts`
- `services/orchestrator/tests/helpers/workerPool.ts`
- `services/orchestrator/tests/intakeProjectPlacement.test.ts`
- `services/orchestrator/tests/loadSpecWithProjectProvenance.test.ts`
- `services/orchestrator/tests/materializeTemplateReconcile.test.ts`
- `services/orchestrator/tests/operatorLive.contract.test.ts`
- `services/orchestrator/tests/projectDerivationActivationEvidence.rls.integration.test.ts`
- `services/orchestrator/tests/projectDerivationLifecycle.rls.integration.test.ts`
- `services/orchestrator/tests/projectDerivationResponseLoss.test.ts`
- `services/orchestrator/tests/projectLifecycleRoutes.test.ts`
- `services/orchestrator/tests/projectSpecWorkflow.test.ts`
- `services/orchestrator/tests/provisionAutonomousProject.test.ts`
- `services/orchestrator/tests/specProgress.test.ts`
- `services/orchestrator/tests/visionInterview.test.ts`
- `services/orchestrator/tests/visionInterviewDesignContract.test.ts`
- `services/orchestrator/tests/visionInterviewLifecycleDrift.test.ts`
- `db/src/schemaInbox.ts`
- `docs/architecture/autonomy-engine.md`
- `services/dashboard/src/api/inboxClient.ts`
- `services/dashboard/src/api/inboxTypes.ts`
- `services/dashboard/src/components/inbox/InboxBody.tsx`
- `services/dashboard/src/components/onboarding/new/ArrivalStep.tsx`
- `services/dashboard/tests/greenfieldOnboarding.render.test.ts`
- `services/dashboard/tests/inbox.render.test.ts`
- `services/orchestrator/src/engine/config/orgConfig.ts`
- `services/orchestrator/src/engine/contracts/deployAdapter.ts`
- `services/orchestrator/src/engine/credentials/githubTokenResolver.ts`
- `services/orchestrator/src/engine/credentials/orgGithubApp.ts`
- `services/orchestrator/src/engine/credentials/refNamespace.ts`
- `services/orchestrator/src/engine/deploy/directApiDeployAdapter.ts`
- `services/orchestrator/src/engine/deploy/manualExternalDeployAdapter.ts`
- `services/orchestrator/src/engine/forge/inbox/connectorErrors.ts`
- `services/orchestrator/src/engine/forge/inbox/connectorMap.ts`
- `services/orchestrator/src/engine/forge/inbox/githubConnector.ts`
- `services/orchestrator/src/engine/forge/inbox/index.ts`
- `services/orchestrator/src/engine/forge/inbox/issuesConnector.ts`
- `services/orchestrator/src/engine/forge/inbox/jiraConnector.ts`
- `services/orchestrator/src/engine/forge/inbox/linearConnector.ts`
- `services/orchestrator/src/engine/forge/inbox/repoLink.ts`
- `services/orchestrator/src/engine/forge/inbox/sentryConnector.ts`
- `services/orchestrator/src/engine/forge/inbox/types.ts`
- `services/orchestrator/src/engine/forge/intake/index.ts`
- `services/orchestrator/src/engine/forge/intake/issueSourceSeam.ts`
- `services/orchestrator/src/engine/forge/intake/pipeline.ts`
- `services/orchestrator/src/engine/forge/intake/poller.ts`
- `services/orchestrator/src/engine/forge/intake/sourceTerminalization.ts`
- `services/orchestrator/src/engine/forge/intake/sourceValidation.ts`
- `services/orchestrator/src/engine/forge/intake/webhookMapping.ts`
- `services/orchestrator/src/engine/forge/intake/webhookProcessor.ts`
- `services/orchestrator/src/engine/integrations/integrationAuthorityEligibility.ts`
- `services/orchestrator/src/engine/integrations/integrationAuthorityValidation.ts`
- `services/orchestrator/src/engine/integrations/provisioningPersistence.ts`
- `services/orchestrator/src/engine/integrations/slack/slackApiTransport.ts`
- `services/orchestrator/src/engine/postMerge/deployOnMergeAuthority.ts`
- `services/orchestrator/src/engine/postMerge/deployOnMergeReads.ts`
- `services/orchestrator/src/engine/provisioners/deployOperationAuthority.ts`
- `services/orchestrator/src/engine/provisioners/deployProvisionerTypes.ts`
- `services/orchestrator/src/engine/provisioners/flyDeployProvisioner.ts`
- `services/orchestrator/src/engine/provisioners/vercelDeployProvisioner.ts`
- `services/orchestrator/src/engine/repositories/inbox.ts`
- `services/orchestrator/src/engine/repositories/inboxSourceLifecycle.ts`
- `services/orchestrator/src/engine/repositories/integrationConnectionFinalizeResult.ts`
- `services/orchestrator/src/engine/repositories/webhookEvents.ts`
- `services/orchestrator/src/routes/githubWebhooks/issues.ts`
- `services/orchestrator/src/routes/inbox/index.ts`
- `services/orchestrator/src/routes/inbox/sourceRecovery.ts`
- `services/orchestrator/src/routes/inbox/webhookProvision.ts`
- `services/orchestrator/src/routes/orgs/index.ts`
- `services/orchestrator/tests/candidateInbox.test.ts`
- `services/orchestrator/tests/candidateInboxJira.test.ts`
- `services/orchestrator/tests/candidateInboxLinear.test.ts`
- `services/orchestrator/tests/conformance/buildDeployAdapter.conformance.test.ts`
- `services/orchestrator/tests/conformance/deployProvisionerNamespacing.test.ts`
- `services/orchestrator/tests/conformance/fakes/scriptedSentryTransport.ts`
- `services/orchestrator/tests/conformance/integrationProvisionerConformance.ts`
- `services/orchestrator/tests/fakes/fakeSentryProvisioner.ts`
- `services/orchestrator/tests/githubTokenResolver.test.ts`
- `services/orchestrator/tests/helpers/sentryIntakeAuthority.ts`
- `services/orchestrator/tests/inboxConnectorWire.test.ts`
- `services/orchestrator/tests/inboxConnectorWireMore.test.ts`
- `services/orchestrator/tests/inboxSourceConfigVertical.test.ts`
- `services/orchestrator/tests/inboxSourceCreation.test.ts`
- `services/orchestrator/tests/inboxSourceRecovery.test.ts`
- `services/orchestrator/tests/inboxStore.test.ts`
- `services/orchestrator/tests/inboxTenantLineageRls.integration.test.ts`
- `services/orchestrator/tests/ingestionAutonomous.test.ts`
- `services/orchestrator/tests/intakeCredentialResolution.test.ts`
- `services/orchestrator/tests/intakeTerminalization.test.ts`
- `services/orchestrator/tests/integrationAuthority.exactOperation.integration.test.ts`
- `services/orchestrator/tests/integrationAuthority.exactOperation.test.ts`
- `services/orchestrator/tests/integrationFinalizationAuthority.test.ts`
- `services/orchestrator/tests/integrations/slackApiTransport.test.ts`
- `services/orchestrator/tests/orgConfig.test.ts`
- `services/orchestrator/tests/orgConfigGateRoutes.test.ts`
- `services/orchestrator/tests/orgGithubApp.test.ts`
- `services/orchestrator/tests/webhookProvisionRetry.test.ts`
<!-- final-freeze-manifest:end -->

Clean replacement also removes the old stable-path helper, incomplete
`listControlGrants` / `resolveControlGrant` eligibility path, naked credential
refs in grant outputs, SQL-string-matching integration memory fake, caller-owned
policy/consent revisions, `manual-link.v1`, and the
`delivery_runs.binding_generations` JSON authority. It does not add a compatibility
view or migration `0042`.

Explicitly outside this cumulative PR: the SP-8 event registry/generated event
schemas (`in-3`), dashboard navigation/`screens.ts` (`in-21`), `main.ts`, and
MergeAuthority files.

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
| Secret finalization saga | Reserve (short TX) → Vault `putCreateOnly`/`cas=0` outside SQL → activate (short TX, op ownership). Auth/grant generation rows are create-only inserts (identical conflict continues; different fails hard).                               |
| Sentry provision scopes  | Catalog provision requires only `project:write` (official create-project/key). Verifier persists proven access scopes; never invents `project:admin`. Full-capability link authorizes provision.                                           |
| Multi-principal UI       | Redirect carries operation id only; GET reloads durable candidates from operation endpoint. Visible chrome: displayName + kind only (hidden principal id in CSRF form). Awaiting/refresh/invalidated/unavailable/completed pinned.         |
| Fly multi-org            | GraphQL `organizations(first, after)` + `pageInfo` cursor advance/duplicate fail-loud; never sole-principal collapse.                                                                                                                      |
| PG/RLS proof             | Live-gated tests seed real 0041 rows (connection→auth gen→grant→grant gen→selection). Memory fake is unit-contract only, not SQL/RLS proof. Opt-in: `TANREN_RLS_DB_TEST=1`.                                                                |

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
