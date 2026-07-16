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
folded into migration `0043`, after the protected `0041` config-CAS and `0042`
event-vocabulary migrations. Link/rotate/eligibility activate completely; binding
workers remain schema-only for later slices.

## Final cumulative fold scope

The final fold is one cumulative clean-replacement candidate, originally built
from the authorized base `67d9363fe220e1f280ed706a0b80af2b16724362` and now
replayed as a 19-commit sequence onto the exact publication base
`8c7d9ff80dfb6f5310c2d2d3a35dd0fc42658897` (post-GV-1). The exact replayed
19-commit head is `7ec09766ef16a5c267a32e8532e8e065a3cbb942`. After the first
card metadata child, exact test-only union convergence head
`7bf2ad5875a92cd160667537d3adb4bb27e2c9a6` replaces one legacy ownerless
credential fixture with supported shorthand and asserts its canonical org-owned
persisted ref; it changes no production behavior. This final card-only child
records that lineage. GV-1 intersected exactly five paths, which were deliberately
unioned to preserve its `auditPosture` reservation/CAS-event authority and IN-1's
lifecycle and org-owned credential semantics. The other 18 replay commit payloads
remain patch-equivalent (two require zero-context patch IDs because the inherited
GV-1 event-helper import changed patch context). This is not a repair delta layered
on an undeclared branch; publish only the lineage rooted at the exact base above.

The manifest below is exhaustive relative to the exact publication target through
the converged candidate: **370 paths = 96 added + 263 modified + 11 deleted**. Each
whitespace-delimited token is `STATUS:path`, where `STATUS` is `A`, `M`, or `D`.
No changed or untracked path may sit outside it. This remains a bounded P1 Slice 1
foundation: binding workers, rotation UI, the complete lifecycle event surface,
and the full callable/visible exercise remain downstream. The strict number of
fully completed consumer DAG nodes claimed by this candidate is **0**. IN-1
remains incomplete until binding activation and the remaining cutover slices land.

### Exhaustive final-fold path manifest

<!-- final-freeze-manifest:start -->

```text
A:db/migrations/0043_integration_lifecycle.sql A:db/migrations/meta/0043_snapshot.json A:db/src/schemaIntegrationBindings.ts
A:db/src/schemaIntegrationConnections.ts A:db/src/schemaIntegrationEnvironment.ts A:db/src/schemaIntegrationOperations.ts
A:db/src/schemaIntegrationPolicy.ts A:db/src/schemaIntegrationRequirements.ts A:db/src/schemaIntegrationSelection.ts
A:db/src/schemaProjectDerivations.ts A:db/src/schemaSpineReferences.ts A:docs/roadmap/mission-complete/nodes/cards/integration-lifecycle-data-model.md
A:services/orchestrator/src/engine/contracts/integrationAuthority.ts A:services/orchestrator/src/engine/contracts/integrationCatalog.ts A:services/orchestrator/src/engine/contracts/integrationSecretStore.ts
A:services/orchestrator/src/engine/forge/intake/sourceTerminalization.ts A:services/orchestrator/src/engine/forge/intake/sourceValidation.ts A:services/orchestrator/src/engine/forge/interview/deployIneligibleError.ts
A:services/orchestrator/src/engine/forge/interview/deriveProductGraph.ts A:services/orchestrator/src/engine/integrations/integrationAuthorityEligibility.ts A:services/orchestrator/src/engine/integrations/integrationAuthorityImpl.ts
A:services/orchestrator/src/engine/integrations/integrationAuthorityValidation.ts A:services/orchestrator/src/engine/integrations/integrationOperationFingerprint.ts A:services/orchestrator/src/engine/integrations/integrationSecretCleanupReaper.ts
A:services/orchestrator/src/engine/integrations/integrationSecretStoreImpl.ts A:services/orchestrator/src/engine/integrations/principalVerifierSupport.ts A:services/orchestrator/src/engine/integrations/principalVerifiers.ts
A:services/orchestrator/src/engine/integrations/provisioningPersistence.ts A:services/orchestrator/src/engine/postMerge/deployOnMergeAuthority.ts A:services/orchestrator/src/engine/provisioners/deployOperationAuthority.ts
A:services/orchestrator/src/engine/provisioners/deployProvisionerTypes.ts A:services/orchestrator/src/engine/repositories/inboxRows.ts A:services/orchestrator/src/engine/repositories/inboxSourceLifecycle.ts
A:services/orchestrator/src/engine/repositories/integrationConnectionActivate.ts A:services/orchestrator/src/engine/repositories/integrationConnectionCleanup.ts A:services/orchestrator/src/engine/repositories/integrationConnectionFinalize.ts
A:services/orchestrator/src/engine/repositories/integrationConnectionFinalizeAssert.ts A:services/orchestrator/src/engine/repositories/integrationConnectionFinalizeResult.ts A:services/orchestrator/src/engine/repositories/integrationConnectionResolve.ts
A:services/orchestrator/src/engine/repositories/integrationConnections.ts A:services/orchestrator/src/engine/repositories/integrationLifecycleInventory.ts A:services/orchestrator/src/engine/repositories/integrationOperationTransitions.ts
A:services/orchestrator/src/engine/repositories/integrationProjectAccess.ts A:services/orchestrator/src/engine/repositories/integrationQuery.ts A:services/orchestrator/src/engine/repositories/projectDerivationReceipts.ts
A:services/orchestrator/src/engine/repositories/projectDerivations.ts A:services/orchestrator/src/engine/workflow/projectCreate.ts A:services/orchestrator/src/engine/workflow/projectDerivationShell.ts
A:services/orchestrator/src/routes/inbox/sourceRecovery.ts A:services/orchestrator/src/routes/integrations/authorityPayloads.ts A:services/orchestrator/src/routes/integrations/authorityWrites.ts
A:services/orchestrator/src/routes/integrations/linkSaga.ts A:services/orchestrator/src/routes/integrations/principalSelectionRoute.ts A:services/orchestrator/src/routes/integrations/selectedPrincipalSaga.ts
A:services/orchestrator/src/routes/integrations/verifierTransition.ts A:services/orchestrator/src/routes/projects/greenfieldCreateStateMachine.ts A:services/orchestrator/src/routes/projects/greenfieldDeployAuthority.ts
A:services/orchestrator/src/routes/projects/greenfieldDeployPrepare.ts A:services/orchestrator/tests/conformance/appEnvironment.conformance.test.ts A:services/orchestrator/tests/conformance/buildDeployAdapter.conformance.test.ts
A:services/orchestrator/tests/conformance/deployProvisionerNamespacing.test.ts A:services/orchestrator/tests/conformance/integrationConnections.conformance.test.ts A:services/orchestrator/tests/fixtures/projectDerivationLifecycle.ts
A:services/orchestrator/tests/helpers/inboxSourceRow.ts A:services/orchestrator/tests/helpers/integrationMemoryActivate.ts A:services/orchestrator/tests/helpers/integrationMemoryDb.ts
A:services/orchestrator/tests/helpers/integrationMemoryFinalize.ts A:services/orchestrator/tests/helpers/integrationMemoryOperations.ts A:services/orchestrator/tests/helpers/integrationMemoryQueries.ts
A:services/orchestrator/tests/helpers/integrationMemoryTables.ts A:services/orchestrator/tests/helpers/orgGrant.ts A:services/orchestrator/tests/helpers/routesPoolDerivationEvidence.ts
A:services/orchestrator/tests/helpers/routesPoolProjectDerivations.ts A:services/orchestrator/tests/helpers/sentryIntakeAuthority.ts A:services/orchestrator/tests/inboxSourceConfigVertical.test.ts
A:services/orchestrator/tests/inboxSourceRecovery.test.ts A:services/orchestrator/tests/inboxStoreDecode.test.ts A:services/orchestrator/tests/integrationAuthority.exactOperation.integration.test.ts
A:services/orchestrator/tests/integrationAuthority.exactOperation.test.ts A:services/orchestrator/tests/integrationAuthority.p0.convergence.test.ts A:services/orchestrator/tests/integrationAuthority.p1.test.ts
A:services/orchestrator/tests/integrationAuthorityRaces.test.ts A:services/orchestrator/tests/integrationConnectionSaga.integration.test.ts A:services/orchestrator/tests/integrationConnectionSagaFailures.integration.test.ts
A:services/orchestrator/tests/integrationFinalizationAuthority.test.ts A:services/orchestrator/tests/integrationLifecycleLineageFk.integration.test.ts A:services/orchestrator/tests/integrationLifecycleMigrationOrder.integration.test.ts
A:services/orchestrator/tests/integrationLifecycleModel.test.ts A:services/orchestrator/tests/integrationLifecycleRls.integration.test.ts A:services/orchestrator/tests/integrationOperationDurability.integration.test.ts
A:services/orchestrator/tests/integrationVaultCas.integration.test.ts A:services/orchestrator/tests/materializeTemplateReconcile.test.ts A:services/orchestrator/tests/projectDerivationActivationEvidence.rls.integration.test.ts
A:services/orchestrator/tests/projectDerivationLifecycle.rls.integration.test.ts A:services/orchestrator/tests/projectDerivationResponseLoss.test.ts A:services/orchestrator/tests/rlsRunLifecycleCredentials.fixtures.ts
D:db/src/schemaIntegrations.ts
D:services/orchestrator/src/engine/forge/inbox/issuesConnector.ts D:services/orchestrator/src/engine/forge/inbox/jiraConnector.ts D:services/orchestrator/src/engine/forge/inbox/linearConnector.ts
D:services/orchestrator/src/engine/repositories/orgIntegrations.ts D:services/orchestrator/src/routes/projects/greenfieldDeployDestroy.ts D:services/orchestrator/tests/candidateInboxJira.test.ts
D:services/orchestrator/tests/candidateInboxLinear.test.ts D:services/orchestrator/tests/conformance/deployProvisionerDestroyApp.test.ts D:services/orchestrator/tests/conformance/integrationRepositories.conformance.test.ts
D:services/orchestrator/tests/inboxConnectorWireMore.test.ts M:ROADMAP.md M:cspell.json
M:db/migrations/meta/_journal.json M:db/src/schema.ts M:db/src/schemaCore.ts
M:db/src/schemaInbox.ts M:docs/architecture/autonomy-engine.md M:docs/contracts/architecture-checks.md
M:docs/design/hifi-work-needed.md M:docs/operator-guide/integration-provisioning.md M:justfile
M:services/dashboard/src/api/inboxClient.ts M:services/dashboard/src/api/inboxTypes.ts M:services/dashboard/src/api/integrations.ts
M:services/dashboard/src/api/integrationsClient.ts M:services/dashboard/src/components/inbox/InboxBody.tsx M:services/dashboard/src/components/integrations/IntegrationsBody.tsx
M:services/dashboard/src/components/integrations/format.ts M:services/dashboard/src/components/integrations/styles.ts M:services/dashboard/src/components/onboarding/new/ArrivalStep.tsx
M:services/dashboard/src/routes/inbox/index.tsx M:services/dashboard/src/routes/integrations/index.tsx M:services/dashboard/tests/greenfieldOnboarding.render.test.ts
M:services/dashboard/tests/inbox.render.test.ts M:services/dashboard/tests/integrations.render.test.ts M:services/orchestrator/src/engine/config/orgConfig.ts
M:services/orchestrator/src/engine/config/projectConfig.ts M:services/orchestrator/src/engine/contracts/awsSecretsManager.ts M:services/orchestrator/src/engine/contracts/codeHost.ts
M:services/orchestrator/src/engine/contracts/codeHostTypes.ts M:services/orchestrator/src/engine/contracts/dagWalker.ts M:services/orchestrator/src/engine/contracts/deployAdapter.ts
M:services/orchestrator/src/engine/contracts/gcpSecretManager.ts M:services/orchestrator/src/engine/contracts/integrationProvisioner.ts M:services/orchestrator/src/engine/contracts/onePassword.ts
M:services/orchestrator/src/engine/contracts/repositories.ts M:services/orchestrator/src/engine/contracts/secretStore.ts M:services/orchestrator/src/engine/credentials/githubTokenResolver.ts
M:services/orchestrator/src/engine/credentials/orgGithubApp.ts M:services/orchestrator/src/engine/credentials/refNamespace.ts M:services/orchestrator/src/engine/credentials/resolveCredentials.ts
M:services/orchestrator/src/engine/credentials/vcsCredentials.ts M:services/orchestrator/src/engine/dag/baseShiftLiveRebase.ts M:services/orchestrator/src/engine/dag/baseShiftLiveResolve.ts
M:services/orchestrator/src/engine/dag/baseShiftLiveSeams.ts M:services/orchestrator/src/engine/dag/baseShiftStackAssembly.ts M:services/orchestrator/src/engine/dag/percolationPg.ts
M:services/orchestrator/src/engine/dag/walker.ts M:services/orchestrator/src/engine/dag/walkerPg.ts M:services/orchestrator/src/engine/deploy/directApiDeployAdapter.ts
M:services/orchestrator/src/engine/deploy/manualExternalDeployAdapter.ts M:services/orchestrator/src/engine/deploy/mobileReleaseDeployAdapter.ts M:services/orchestrator/src/engine/deploy/packageReleaseDeployAdapter.ts
M:services/orchestrator/src/engine/deploy/pulumiDeployAdapter.ts M:services/orchestrator/src/engine/design/designContract.ts M:services/orchestrator/src/engine/design/designPhase.ts
M:services/orchestrator/src/engine/forge/audits/answererPassRunner.ts M:services/orchestrator/src/engine/forge/audits/seedCatalog.ts M:services/orchestrator/src/engine/forge/inbox/ciInsightsSource.ts
M:services/orchestrator/src/engine/forge/inbox/connectorErrors.ts M:services/orchestrator/src/engine/forge/inbox/connectorMap.ts M:services/orchestrator/src/engine/forge/inbox/githubConnector.ts
M:services/orchestrator/src/engine/forge/inbox/index.ts M:services/orchestrator/src/engine/forge/inbox/repoLink.ts M:services/orchestrator/src/engine/forge/inbox/sentryConnector.ts
M:services/orchestrator/src/engine/forge/inbox/types.ts M:services/orchestrator/src/engine/forge/intake/index.ts M:services/orchestrator/src/engine/forge/intake/issueSourceSeam.ts
M:services/orchestrator/src/engine/forge/intake/poller.ts M:services/orchestrator/src/engine/forge/intake/webhookMapping.ts M:services/orchestrator/src/engine/forge/intake/webhookProcessor.ts
M:services/orchestrator/src/engine/forge/interview/deployDependency.ts M:services/orchestrator/src/engine/forge/interview/derive.ts M:services/orchestrator/src/engine/forge/interview/deriveBehaviorSpec.ts
M:services/orchestrator/src/engine/forge/interview/deriveCompensation.ts M:services/orchestrator/src/engine/forge/interview/deriveDesignContract.ts M:services/orchestrator/src/engine/forge/interview/deriveEntityGraph.ts
M:services/orchestrator/src/engine/forge/interview/engine.ts M:services/orchestrator/src/engine/forge/interview/index.ts M:services/orchestrator/src/engine/forge/runnerContext.ts
M:services/orchestrator/src/engine/forge/tools/repo.ts M:services/orchestrator/src/engine/integrations/provisioningEngine.ts M:services/orchestrator/src/engine/integrations/slack/slackApiTransport.ts
M:services/orchestrator/src/engine/integrations/slack/slackProvisioner.ts M:services/orchestrator/src/engine/merge/batchChecker.ts M:services/orchestrator/src/engine/merge/driveCi.ts
M:services/orchestrator/src/engine/merge/driveConflictResolveJj.ts M:services/orchestrator/src/engine/merge/freshRunnerGate.ts M:services/orchestrator/src/engine/merge/mergeAuthorityBundleBuild.ts
M:services/orchestrator/src/engine/notifications/channels/githubChecks.ts M:services/orchestrator/src/engine/notifications/seedDefaultRoute.ts M:services/orchestrator/src/engine/postMerge/demoOnDeploy.ts
M:services/orchestrator/src/engine/postMerge/deployOnMerge.ts M:services/orchestrator/src/engine/postMerge/deployOnMergeReads.ts M:services/orchestrator/src/engine/postMerge/deployTargetResolution.ts
M:services/orchestrator/src/engine/postMerge/watcher.ts M:services/orchestrator/src/engine/providers/botPushIdentity.ts M:services/orchestrator/src/engine/providers/github.ts
M:services/orchestrator/src/engine/providers/githubCodeHost.ts M:services/orchestrator/src/engine/providers/githubRepoCreate.ts M:services/orchestrator/src/engine/providers/liveJjWorkspace.ts
M:services/orchestrator/src/engine/providers/sentryProvisioner.ts M:services/orchestrator/src/engine/provisioners/deployProvisioner.ts M:services/orchestrator/src/engine/provisioners/flyDeployProvisioner.ts
M:services/orchestrator/src/engine/provisioners/vercelDeployProvisioner.ts M:services/orchestrator/src/engine/repositories/appEnvironment.ts M:services/orchestrator/src/engine/repositories/inbox.ts
M:services/orchestrator/src/engine/repositories/index.ts M:services/orchestrator/src/engine/repositories/organizations.ts M:services/orchestrator/src/engine/repositories/projects.ts
M:services/orchestrator/src/engine/repositories/webhookEvents.ts M:services/orchestrator/src/engine/templates/fragments/materialize.ts M:services/orchestrator/src/engine/worker/boot.ts
M:services/orchestrator/src/engine/worker/runExecutor.ts M:services/orchestrator/src/engine/workflow/attachRuntimeAppEnv.ts M:services/orchestrator/src/engine/workflow/githubDraftPr.ts
M:services/orchestrator/src/engine/workflow/plannerRunAdapters.ts M:services/orchestrator/src/engine/workflow/plannerRunCi.ts M:services/orchestrator/src/engine/workflow/plannerRunWorkspace.ts
M:services/orchestrator/src/engine/workflow/projectConfigWriteGuards.ts M:services/orchestrator/src/engine/workflow/projectSpec.ts M:services/orchestrator/src/engine/workflow/projectSpecRowSchema.ts
M:services/orchestrator/src/engine/workflow/provisionAutonomousProject.ts M:services/orchestrator/src/engine/workflow/resolveAppEnv.ts M:services/orchestrator/src/engine/workflow/reviewMerge/conflictResolver/jjAuthedPush.ts
M:services/orchestrator/src/engine/workflow/reviewMerge/conflictResolver/jjWorkspaceApplier.ts M:services/orchestrator/src/engine/workflow/reviewMerge/context.ts M:services/orchestrator/src/engine/workflow/reviewMerge/mergeDispatch.ts
M:services/orchestrator/src/engine/workflow/reviewMerge/reviewPolling.ts M:services/orchestrator/src/inputSchemas.ts M:services/orchestrator/src/main.ts
M:services/orchestrator/src/mountRootApiRoutes.ts M:services/orchestrator/src/routes/brownfield/fullTrack.ts M:services/orchestrator/src/routes/brownfield/index.ts
M:services/orchestrator/src/routes/githubWebhooks/issues.ts M:services/orchestrator/src/routes/inbox/index.ts M:services/orchestrator/src/routes/inbox/webhookProvision.ts
M:services/orchestrator/src/routes/integrations/index.ts M:services/orchestrator/src/routes/onboarding/index.ts M:services/orchestrator/src/routes/onboarding/materializeTemplate.ts
M:services/orchestrator/src/routes/orgs/github.ts M:services/orchestrator/src/routes/orgs/index.ts M:services/orchestrator/src/routes/projects/greenfield.ts
M:services/orchestrator/src/routes/projects/greenfieldRepoCreate.ts M:services/orchestrator/src/routes/projects/greenfieldRepoDelete.ts M:services/orchestrator/src/routes/projects/greenfieldRepoProbe.ts
M:services/orchestrator/src/routes/projects/index.ts M:services/orchestrator/src/routes/projects/lifecycle.ts M:services/orchestrator/tests/acceptanceHardTier.fixtures.ts
M:services/orchestrator/tests/answererPassRunner.test.ts M:services/orchestrator/tests/appEnvInjection.test.ts M:services/orchestrator/tests/attachRuntimeAppEnv.test.ts
M:services/orchestrator/tests/auditSchedulerLoop.test.ts M:services/orchestrator/tests/awsSecretsManager.test.ts M:services/orchestrator/tests/bootstrapCommitIdentity.test.ts
M:services/orchestrator/tests/brownfieldLink.test.ts M:services/orchestrator/tests/candidateInbox.test.ts M:services/orchestrator/tests/ciInsightsGenerative.test.ts
M:services/orchestrator/tests/conflictResolveBotIdentity.test.ts M:services/orchestrator/tests/conformance/conformanceMemoryDb.ts M:services/orchestrator/tests/conformance/dagWalker.conformance.test.ts
M:services/orchestrator/tests/conformance/deployAdapter.conformance.test.ts M:services/orchestrator/tests/conformance/deployProvisioner.test.ts M:services/orchestrator/tests/conformance/extendedDeployAdapter.conformance.test.ts
M:services/orchestrator/tests/conformance/fakes/awsSecretsManagerFetch.ts M:services/orchestrator/tests/conformance/fakes/fakeRepoCreateHttp.ts M:services/orchestrator/tests/conformance/fakes/scriptedSentryTransport.ts
M:services/orchestrator/tests/conformance/flyDeployReleaseConfig.test.ts M:services/orchestrator/tests/conformance/flyImageBuilder.test.ts M:services/orchestrator/tests/conformance/forgeRecoveryMemoryDb.ts
M:services/orchestrator/tests/conformance/integrationProvisioner.conformance.test.ts M:services/orchestrator/tests/conformance/integrationProvisionerConformance.ts M:services/orchestrator/tests/conformance/manualExternalDeployAdapter.conformance.test.ts
M:services/orchestrator/tests/conformance/mobileReleaseDeployAdapter.conformance.test.ts M:services/orchestrator/tests/conformance/packageReleaseDeployAdapter.conformance.test.ts M:services/orchestrator/tests/conformance/pulumiDeployAdapter.conformance.test.ts
M:services/orchestrator/tests/conformance/repositoriesConformance.ts M:services/orchestrator/tests/coordinatorBuildDriveScope.test.ts M:services/orchestrator/tests/dagBaseShiftOrgScope.test.ts
M:services/orchestrator/tests/dagPercolationReadModel.test.ts M:services/orchestrator/tests/dagSpeculation.test.ts M:services/orchestrator/tests/dagWalkerAncestorNotReadyBackoff.test.ts
M:services/orchestrator/tests/dagWalkerConcurrentTickTolerance.test.ts M:services/orchestrator/tests/dagWalkerPlan.test.ts M:services/orchestrator/tests/dagWalkerSpeculative.test.ts
M:services/orchestrator/tests/demoOnDeploy.test.ts M:services/orchestrator/tests/demoOnDeployAdapterDispatch.test.ts M:services/orchestrator/tests/deployOnMerge.test.ts
M:services/orchestrator/tests/deployTransportRobustness.test.ts M:services/orchestrator/tests/deriveAtomicRollback.test.ts M:services/orchestrator/tests/deriveGreenfieldReattachGuard.test.ts
M:services/orchestrator/tests/draftPrCreatedPlaneSplit.test.ts M:services/orchestrator/tests/driveConflictResolve.test.ts M:services/orchestrator/tests/driveMergePercolationYield.test.ts
M:services/orchestrator/tests/fakes/fakeSentryProvisioner.ts M:services/orchestrator/tests/fixtures/forge/interviewDeriveStub.ts M:services/orchestrator/tests/freshRunnerGateUniqueHandle.test.ts
M:services/orchestrator/tests/gcpSecretManager.test.ts M:services/orchestrator/tests/githubConnectRoutes.test.ts M:services/orchestrator/tests/githubDraftPr.test.ts
M:services/orchestrator/tests/githubDraftPrStackedBase.test.ts M:services/orchestrator/tests/githubDraftPrTitle.test.ts M:services/orchestrator/tests/githubRateLimit.test.ts
M:services/orchestrator/tests/githubTokenResolver.test.ts M:services/orchestrator/tests/greenfieldCreateIdempotency.test.ts M:services/orchestrator/tests/greenfieldDeployRequiredRoutes.test.ts
M:services/orchestrator/tests/helpers/githubDraftPrFakes.ts M:services/orchestrator/tests/helpers/greenfieldRoutes.ts M:services/orchestrator/tests/helpers/progressRoutesPool.ts
M:services/orchestrator/tests/helpers/recoveryMemoryPool.ts M:services/orchestrator/tests/helpers/routesPool.ts M:services/orchestrator/tests/helpers/workerExec.ts
M:services/orchestrator/tests/helpers/workerPool.ts M:services/orchestrator/tests/inboxConnectorWire.test.ts M:services/orchestrator/tests/inboxSourceCreation.test.ts
M:services/orchestrator/tests/inboxStore.test.ts M:services/orchestrator/tests/ingestionAutonomous.test.ts M:services/orchestrator/tests/intakeAutonomous.test.ts
M:services/orchestrator/tests/intakeCredentialResolution.test.ts M:services/orchestrator/tests/intakeProjectPlacement.test.ts M:services/orchestrator/tests/integrationProvisioningEngine.test.ts
M:services/orchestrator/tests/integrationRoutes.contract.test.ts M:services/orchestrator/tests/integrations/slackApiTransport.test.ts M:services/orchestrator/tests/integrations/slackProvisioner.test.ts
M:services/orchestrator/tests/issueWebhookRoute.test.ts M:services/orchestrator/tests/liveJjWorkspace.test.ts M:services/orchestrator/tests/loadSpecWithProjectProvenance.test.ts
M:services/orchestrator/tests/mergeQueueEarlyEnqueue.test.ts M:services/orchestrator/tests/notificationsGithubChecksChannel.test.ts M:services/orchestrator/tests/onePassword.test.ts
M:services/orchestrator/tests/operatorLive.contract.test.ts M:services/orchestrator/tests/orgConfigGateRoutes.test.ts M:services/orchestrator/tests/orgGithubApp.test.ts
M:services/orchestrator/tests/percolationCredentialResolution.test.ts M:services/orchestrator/tests/plannerRun.fixtures.ts M:services/orchestrator/tests/plannerRunWorkspaceCloneAuth.test.ts
M:services/orchestrator/tests/postMergeWatcher.test.ts M:services/orchestrator/tests/projectAutonomousConfigPolicies.test.ts M:services/orchestrator/tests/projectCreateDeployGuard.test.ts
M:services/orchestrator/tests/projectLifecycleRoutes.test.ts M:services/orchestrator/tests/projectSpecWorkflow.test.ts M:services/orchestrator/tests/provisionAutonomousProject.test.ts
M:services/orchestrator/tests/resolveAppEnv.test.ts M:services/orchestrator/tests/resolveCredentials.test.ts M:services/orchestrator/tests/reviewMerge.fixtures.ts
M:services/orchestrator/tests/reviewMergeContext.test.ts M:services/orchestrator/tests/rlsRunLifecycleScoping.integration.test.ts M:services/orchestrator/tests/runExecutionContext.test.ts
M:services/orchestrator/tests/runExecutor.test.ts
M:services/orchestrator/tests/scheduledAudits.test.ts M:services/orchestrator/tests/scheduledAuditsAutoRoute.test.ts M:services/orchestrator/tests/scheduledAuditsPostureRoute.test.ts
M:services/orchestrator/tests/scheduledAuditsRemediation.test.ts M:services/orchestrator/tests/silentFallbackConfigCorruption.test.ts M:services/orchestrator/tests/specProgress.test.ts
M:services/orchestrator/tests/vaultPerRunScopedCreds.test.ts M:services/orchestrator/tests/vercelDeployProvisionerPager.test.ts M:services/orchestrator/tests/visionInterview.test.ts
M:services/orchestrator/tests/visionInterviewDesignContract.test.ts M:services/orchestrator/tests/visionInterviewLifecycleDrift.test.ts M:services/orchestrator/tests/webhookProvisionRetry.test.ts
M:services/orchestrator/tests/workerBoot.test.ts M:services/orchestrator/tests/workerLifecycle.test.ts
```

<!-- final-freeze-manifest:end -->

Clean replacement also removes the old stable-path helper, incomplete
`listControlGrants` / `resolveControlGrant` eligibility path, naked credential
refs in grant outputs, SQL-string-matching integration memory fake, caller-owned
policy/consent revisions, `manual-link.v1`, and the
`delivery_runs.binding_generations` JSON authority. It does not add a compatibility
view. The lifecycle schema lands only in `0043`; the exact protected `0041` and
`0042` migration/snapshot bytes remain unchanged from the authorized base.

Explicitly outside this cumulative candidate: completion of the SP-8 event surface
(`in-3`), dashboard navigation/`screens.ts` (`in-21`), binding workers, and the
remaining lifecycle consumer-node transitions. Root wiring and merge/review call
sites are in scope only where tenant-owned credentials must be propagated.

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

The stable-grant selection FK intentionally uses
`(org_id, connection_id, grant_id)` without the redundant `provider_kind`. That
tuple is unique on `org_integration_grants`; the selection's connection FK and
exact grant-generation FK both include `provider_kind`, so a row cannot cross a
tenant, connection, provider, or grant-generation boundary. This narrower stable
identity FK is therefore not an authority hole; revisit it only if the unique
grant identity or the exact-generation FK changes.

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

### Tenant, configuration, and recovery convergence

- GitHub/VCS credential resolution requires the owning `org_id`; project create,
  update, derivation, merge/review, worker, and draft-PR paths accept only
  canonical tenant-owned refs. Foreign-org and raw coordinates fail closed.
- Project configuration writes use the sole `ProjectStore` snapshot/CAS mutation
  path. Expected revisions are mandatory, stale writers conflict, and semantic
  no-ops do not advance the revision.
- Inbox rows decode strictly with complete source lifecycle fields. GitHub rate
  limits schedule durable retries without in-process sleeping; source recovery is
  CAS-protected, rolls back on provisioning failure, and is visible in dashboard
  recovery state.
- Deploy receipts must match the selected provider prefix before activation.

## Callable and visible slice

Authenticated org admin link/rotate returns `202` with sanitized operation URL/state.
Principal-selection resumes multi-principal credentials. Inventory shows verified
principal, health, expiry, current generations, operation state, and ineligibility
reasons — never credential refs/tokens. UI removes account/workspace ID input and
never echoes submitted tokens. Events append only through the canonical EventStore.

## Verification

- Schema contract: all P1 tables, direct `org_id`, composite tenant FKs, enum/digest
  checks, forced RLS, absence of legacy authorities.
- Fresh empty PostgreSQL applies `0000→0043` with every new prerequisite unique
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
| PG/RLS proof             | Live-gated tests apply the real `0000→0043` chain and seed connection→auth generation→grant→grant generation→selection rows. Memory fakes remain unit-contract proof only. Opt-in: `TANREN_RLS_DB_TEST=1`.                                 |

**Not claimed:** full IN-1 node completion, binding workers, any completed
downstream consumer DAG node (credit remains **0**), or completion of the deferred
SP-8 event surface (`in-3`).

### Live obligations (skipped when credentials/DB absent)

- Real PG: `TANREN_RLS_DB_TEST=1` + `DATABASE_URL` → RLS + migration-order tests.
- Live Vault CAS create-only + live Slack/Sentry/Vercel/Fly principal verification when provider credentials present.
- Architecture former-bug greps in `integrationAuthority.p0.convergence.test.ts`.

## Gate

`just affected-typecheck`, `just affected-test`, architecture/contract/schema drift,
`just fast-check`, `just ci`, then serialized `just smoke`. Do not claim IN-1 node
completion until Slice 2/3 land binding activation and remaining cutover.

### Candidate validation (2026-07-16)

- Post-GV focused union proof passed 41/41: governance CAS/event behavior 14/14
  and project create/PATCH guards 27/27, including canonical owner binding,
  foreign-owner rejection, `auditPosture` reservation, and structural no-op.
- Affected typecheck passed; affected tests passed 491 files / 4,786 tests, with
  56 files / 304 live-gated tests skipped.
- Schema drift reported no changes. Protected `0041`/`0042` migration and snapshot
  bytes match the authorized base; journal order is exactly `0040→0041→0042→0043`.
- Live PostgreSQL: lifecycle/RLS/lineage/saga/operation recipe 27/27; config CAS
  11/11; derivation lifecycle/activation 7/7; exact-operation authority 1/1.
- `just fast-check` and build-inclusive `just ci` passed: 706 files / 6,818 tests,
  with 57 files / 318 live-gated tests skipped; all five package builds passed.
- Fresh-stack serialized `__ETC_BASHRC_SOURCED=1 just smoke` passed. The export
  works around this Nix host's `/etc/bashrc` dereferencing its own unset guard
  under the justfile's `bash -u`; no recipe behavior was bypassed. The lifecycle
  RLS proof passed 2/2: the canonical org-owned ref completed, while a
  mismatched-owner ref failed hydration with zero derived tasks, runners, events,
  or costs. The worktree's Compose project/volumes were removed and its ports
  released after the gate.
