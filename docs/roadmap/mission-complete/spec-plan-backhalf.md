# Back-half full-tier build plan

<!-- cspell:ignore Xplain rollouts readbacks rollups rebuildable -->

This plan replaces the collapsed `bh-15..35` bucket with 21 buildable consumer
nodes. Every node extends the normal project- and org-scoped resolution pipeline:
`IssueSourceAdapter` intake, immutable behavior and symptom contracts, SP-5 runtime
verification, SP-6 release lifecycle, `ResolutionDagWalker`, the sole
`ResolutionAuthority`, the sole SP-3 `ProofSubstrate`, and native jj/
`MergeAuthorityV2` delivery. No node introduces a second proof store, verifier,
fragment composer, merge path, or fixture-specific mode.

## Decisions frozen by this plan

- Rich probes split at the SP-5 driver boundary: browser/structured observation is
  `bh-16`; external-effect and non-web observation is `bh-17`.
- Source breadth splits by normalization and conformance behavior: telemetry
  (`bh-21`), work trackers and generic signed webhooks (`bh-22`), SARIF (`bh-23`),
  and dependency/advisory policy (`bh-24`). All implement the existing
  `IssueSourceAdapter`; none creates a source-specific resolution engine.
- Progressive rollout and rollback are separate nodes because rollout advances a
  candidate through cohorts while rollback restores a previously verified artifact
  and has a different authority decision and negative control.
- SP-5 remains the only executable verification harness, SP-6 remains the only
  release lifecycle, SP-2 remains the only authoring kernel, SP-3 remains the only
  proof and byte store, and `services/orchestrator/src/engine/eventStore.ts` remains
  the only event append path.
- Migrations are serialized from the current tail `0110`; every new tenant table
  has `org_id NOT NULL`, composite org-scoped foreign keys, an org index, an
  `rls_org_isolation` policy, `ENABLE ROW LEVEL SECURITY`, and
  `FORCE ROW LEVEL SECURITY`.

## Node roster

| ID    | Name                                              | Capability assignment           | Wave | Migration | Size |
| ----- | ------------------------------------------------- | ------------------------------- | ---: | --------- | ---: |
| bh-15 | Locked behavior-context loader                    | behavior loading                |    1 | none      | ~650 |
| bh-16 | Multimodal browser symptom driver                 | rich probes: browser/structured |    2 | none      | ~900 |
| bh-17 | External-effect symptom driver                    | rich probes: non-web/effects    |    2 | none      | ~850 |
| bh-18 | Preview and canary symptom stage                  | preview/canary                  |    3 | 0111      | ~900 |
| bh-19 | Counterfactual artifact replay                    | counterfactual replay           |    3 | 0112      | ~850 |
| bh-20 | Resolution verification fragment composition      | F2 fragments                    |    3 | none      | ~800 |
| bh-21 | Telemetry issue source adapter                    | more sources: telemetry         |    4 | none      | ~850 |
| bh-22 | Work-tracker and generic issue source adapters    | more sources: trackers/generic  |    4 | none      | ~950 |
| bh-23 | SARIF security finding source adapter             | more sources: static analysis   |    4 | none      | ~800 |
| bh-24 | Dependency and advisory source policy             | more sources: dependencies      |    4 | 0113      | ~950 |
| bh-25 | Soak policy and proof grades                      | soak grades                     |    5 | 0114      | ~950 |
| bh-26 | Integration-batch symptom verification and bisect | batch verify + bisect           |    5 | 0115      | ~950 |
| bh-27 | Entity-scoped release health barriers             | health barriers                 |    6 | 0116      | ~900 |
| bh-28 | Progressive rollout controller                    | rollout                         |    7 | 0117      | ~950 |
| bh-29 | Verified-artifact traffic rollback                | rollback                        |    7 | 0118      | ~850 |
| bh-30 | Cross-repository resolution loop                  | cross-repo loops                |    8 | 0119      | ~950 |
| bh-31 | Failure-aware repair routing                      | failure-aware routing           |    8 | 0120      | ~950 |
| bh-32 | Signed resolution certificate                     | signed certificates             |    9 | none      | ~850 |
| bh-33 | Resolution proof verification CLI                 | proof-verify CLI                |    9 | none      | ~750 |
| bh-34 | Resolution fleet analytics                        | fleet analytics                 |    9 | 0121      | ~950 |
| bh-35 | Live resolution conformance burn-in               | live burn-in                    |   10 | 0122      | ~950 |

## bh-15 — Locked behavior-context loader

- **id**: `bh-15` · **name**: Locked behavior-context loader
- **What** — Add a resolution-specific loader in
  `services/orchestrator/src/engine/verification/resolutionStages/` that resolves the
  exact `BehaviorRevisionId` and `PersonaRevisionId` set bound to the active
  `SymptomContractV1`, loads full Given/When/Then and acceptance bodies through
  `repositories/behaviorRevisionStore.ts` and
  `verification/acceptance/pgAcceptancePlanLoader.ts`, and passes one immutable
  `RuntimeBehaviorContext` into baseline, preview, production, counterfactual, and
  soak jobs through `contracts/resolutionStage.ts`. The canonical context digest is
  stored in the existing verification-run facts, returned by the issue-loop
  verification API, and displayed beside each stage in Self-Healing loop detail.
- **Acceptance** — Positive: `resolutionBehaviorContext.integration.test.ts` creates
  two behavior revisions, binds one revision to a symptom contract, mutates the
  behavior head, and proves baseline and production load the original full
  Given/When/Then body and identical context digest. **Required negative control:**
  delete or cross-org-hide one bound revision and prove the job becomes
  `inconclusive/stale_contract`; the probe, `ResolutionAuthority`, and source-close
  outbox never run with an empty, latest, or substituted behavior.
- **Deps** — bh-4, bh-6, bh-10; SP-1
  `contracts/behaviorRevision.ts`; SP-5 `contracts/runtimeVerificationPlan.ts` and
  `verification/acceptance/pgAcceptancePlanLoader.ts`.
- **Migration** — none; reuse immutable `behavior_revisions`,
  `release_instance_behavior_revisions`, and `behavior_verification_runs`.
- **Size** — ~650 non-generated lines.
- **Order** — wave 1; every richer stage must execute the same locked behavior
  context before probe, preview, replay, or soak work fans out.

## bh-16 — Multimodal browser symptom driver

- **id**: `bh-16` · **name**: Multimodal browser symptom driver
- **What** — Implement the browser/structured arm of `SymptomProbeDriver` in
  `services/orchestrator/src/engine/probes/` by adapting SP-5
  `verification/acceptance/browserDriver.ts`, `renderCaptureStage.ts`, and
  `designRenderStage.ts` into the existing `contracts/symptomProbe.ts` result. It
  executes HTTP/JSON, DOM, accessibility-tree, visual, console, and network
  assertions from the locked acceptance plan and stores screenshots, traces, DOM,
  HAR/network, and structured observations only through SP-3/CAS and the existing
  symptom-evidence repository. Assertion-level evidence is callable from the
  issue-loop verification API and visible as a before/after evidence panel.
- **Acceptance** — Positive: `multimodalSymptomProbe.integration.test.ts` runs a
  containerized web surface whose response is HTTP 200 while a DOM property,
  accessibility role, and pixel checkpoint are wrong, and proves all three failures
  and their SP-3 evidence digests are recorded; correcting the surface produces
  decisive passes with a retained trace. **Required negative control:** return HTTP
  200 with the semantic DOM defect intact and prove reachability cannot convert the
  failed rich assertions into `passed` or authorize resolution.
- **Deps** — bh-5, bh-15; rv-6, rv-11, rv-13, ds-4; SP-3 and SP-5.
- **Migration** — none; reuse `verification_assertions`, `symptom_evidence`,
  `verification_artifacts`, and the sole SP-3 byte store.
- **Size** — ~900 non-generated lines.
- **Order** — wave 2; it consumes the locked context and supplies active web evidence
  to all later release stages.

## bh-17 — External-effect symptom driver

- **id**: `bh-17` · **name**: External-effect symptom driver
- **What** — Implement the non-browser arm of `SymptomProbeDriver` by adapting SP-5
  fixture leases, side-effect observers, A3 causal correlation, and `DemoSurface`
  dispatch for API, CLI, package, app-channel, mobile, and external-integration
  behaviors. The driver uses `verification/effectObserver/`,
  `verification/fixtureLease/`, `contracts/runtimeVerificationPlan.ts`, and
  `contracts/deployAdapter.ts`; it records trigger/effect identities, provider
  receipts, stdout, cleanup assertions, and causal verdicts in the existing SP-5/SP-3
  evidence path, exposes them through issue-loop verification reads, and renders
  causal timelines in loop detail.
- **Acceptance** — Positive: `externalEffectSymptomProbe.conformance.test.ts` runs the
  same contract against scripted API, CLI, package, app-channel, and external-effect
  surfaces and proves each arm returns an assertion-level causal verdict with cleanup
  evidence. **Required negative control:** make the trigger succeed while the
  observer returns an incomplete page or an unmatched effect; prove the outcome is
  `inconclusive` or `failed`, never a pass inferred from trigger success, and prove a
  leaked fixture blocks completion.
- **Deps** — bh-5, bh-15; rv-7, rv-8, rv-10, in-19; SP-5 and SP-6.
- **Migration** — none; reuse SP-5 fixture leases, effect observations,
  verification artifacts, and symptom evidence.
- **Size** — ~850 non-generated lines.
- **Order** — wave 2; it is parallel with bh-16 and completes the surface coverage
  required by preview, counterfactual, and soak stages.

## bh-18 — Preview and canary symptom stage

- **id**: `bh-18` · **name**: Preview and canary symptom stage
- **What** — Add a `preview` resolution stage to `contracts/resolutionStage.ts` and
  `dag/resolutionDagWalkerBuild.ts` that uses the single SP-6 `DeployAdapter` to
  `buildArtifact` and `applyPreview`, executes the same locked contract through the
  bh-16/bh-17 driver selected by `RequiredSurface`, tears the preview down, and
  supplies the exact release, behavior verdicts, and proof bundle to the existing
  pre-land native gate and `MergeAuthorityV2` input. Required preview capability
  failures are typed blocks, not `not_required`; status and evidence are returned by
  the issue-loop API and shown on loop and queue detail.
- **Acceptance** — Positive: `previewSymptomStage.integration.test.ts` builds one
  exact artifact, applies it to a provider-neutral preview adapter, records a
  `preview` verification run, passes the locked contract, reuses its exact digest in
  the gate bundle, and tears the preview down. **Required negative control:** make
  the preview answer the readiness probe while the symptom assertion fails, then
  prove `MergeAuthorityV2` receives a blocking runtime verdict and no land or
  promotion occurs; an unavailable required preview also blocks instead of passing.
- **Deps** — bh-15, bh-16, bh-17; rv-5, rv-14, rv-15; mq-13; SP-4, SP-5, SP-6, SP-7.
- **Migration** — `0111_preview_resolution_stage.sql`: replace the existing
  `behavior_verification_runs_resolution_stage_check` so `stage` accepts exactly
  `baseline`, `preview`, `production`, `counterfactual`, or `soak`; no table or
  nullable compatibility column is added.
- **Size** — ~900 non-generated lines.
- **Order** — wave 3; both probe families and effective native-gate proof bindings
  must exist before preview evidence controls landing.

## bh-19 — Counterfactual artifact replay

- **id**: `bh-19` · **name**: Counterfactual artifact replay
- **What** — Add a `counterfactual` stage implementation under
  `verification/resolutionStages/` that acquires a retention lease for the exact
  baseline artifact, recreates or resolves its SP-6 surface after the candidate is
  live, and runs the identical contract/context alongside the new artifact. It
  records old-fails/new-passes as the `active_causal` input to the sole
  `ResolutionAuthority`; unavailable retained artifacts produce an explicit weaker
  grade rather than fabricated evidence. The paired results are exposed by the
  proof API and rendered as an artifact-bound comparison.
- **Acceptance** — Positive: `counterfactualReplay.integration.test.ts` retains
  release A, promotes release B, proves A still fails while B passes under the same
  contract and context digests, and authorizes `active_causal`. **Required negative
  control:** point the old-release handle at B or expire the lease before replay and
  prove artifact-digest mismatch or absence prevents `active_causal`, prevents
  source closure under the default policy, and records the honest weaker grade.
- **Deps** — bh-9, bh-10, bh-15, bh-16, bh-17; SP-3, SP-5, SP-6.
- **Migration** — `0112_release_retention_leases.sql`: add
  `release_retention_leases(org_id, project_id, id, release_instance_id,
reason, state, lease_owner, lease_expires_at, acquired_at, released_at)` with a
  unique live lease per org/release/reason, composite org foreign keys, org index,
  and FORCE RLS.
- **Size** — ~850 non-generated lines.
- **Order** — wave 3; it reuses the complete probe surface and must precede proof
  grades, certificates, and autonomous closure policies.

## bh-20 — Resolution verification fragment composition

- **id**: `bh-20` · **name**: Resolution verification fragment composition
- **What** — Connect `symptom_contract_fragments` to the existing SP-2 verification
  fragment path in `verification/acceptance/fragments/`,
  `repositories/verificationFragmentStore.ts`, and
  `forge/verificationFragmentAuthoringFactory.ts`. Contract validation resolves
  every capability key to a versioned/hash-bound fragment; a missing capability
  runs the normal writer-to-validator authoring kernel, conformance-validates the
  fragment against its declared surface, and creates a prerequisite
  `probe_capability` spec origin before the resolution job resumes. The resolved
  fragment set is callable from contract/proof APIs and visible on contract detail.
- **Acceptance** — Positive: `resolutionFragmentComposition.integration.test.ts`
  submits a contract with one existing and one missing capability, proves the
  missing capability is authored through SP-2, validated, persisted once, bound by
  exact version/hash, and then used by a real SP-5 execution. **Required negative
  control:** return a no-op, cross-org, or conformance-failing fragment and prove it
  is rejected and retracted, the resolution job remains blocked, and no generic
  script or from-scratch fallback executes.
- **Deps** — bh-2, bh-4, bh-5, bh-15; rv-3; SP-2, SP-3, SP-5.
- **Migration** — none; reuse `verification_fragments`, their existing version/
  conformance tables, `symptom_contract_fragments`, and `spec_origins` role
  `probe_capability`.
- **Size** — ~800 non-generated lines.
- **Order** — wave 3; the locked plan and both probe adapters define the capability
  contract that authored fragments must satisfy.

## bh-21 — Telemetry issue source adapter

- **id**: `bh-21` · **name**: Telemetry issue source adapter
- **What** — Implement a telemetry provider behind
  `engine/forge/issueSourceAdapter.ts` and the existing inbox source registration
  seam. It verifies signed deliveries, normalizes group/event/release/environment,
  stack/trace context, regression/reopen state, and provider revision into immutable
  `source_findings`, supports comment/resolve/reopen/readback, and reconciles by
  provider cursor after missed pushes. Provider-specific transport stays behind the
  adapter; issue-loop state, HTTP source administration, source health, and event
  history remain provider-neutral.
- **Acceptance** — Positive: `telemetryIssueSourceAdapter.conformance.test.ts` drives
  signed new-event, regression, resolve, missed-webhook reconciliation, mutation,
  and readback fixtures through the shared adapter suite and proves one causal issue
  loop with immutable revisions. **Required negative control:** send an invalid
  signature and a stale release association and prove neither can create an accepted
  finding or close a loop; telemetry silence alone never becomes resolution proof.
- **Deps** — bh-1, bh-3, bh-7, bh-12; SP-3 and SP-8.
- **Migration** — none; normalized provider metadata fits existing
  `inbox_sources`, `webhook_events`, `source_findings.context`, and
  `source_sync_outbox`.
- **Size** — ~850 non-generated lines.
- **Order** — wave 4; source adapters build independently after the reusable closed
  loop and source-sync contract are complete.

## bh-22 — Work-tracker and generic issue source adapters

- **id**: `bh-22` · **name**: Work-tracker and generic issue source adapters
- **What** — Add one declarative work-item transport behind the existing
  `IssueSourceAdapter`, with versioned Linear-class, Jira-class, Slack-class, and
  generic signed-webhook mapping profiles, plus one shared conformance suite
  covering create/edit/close/reopen/comment/readback,
  cursor reconciliation, signature rotation, rate-limit classification, and
  redaction. Generic payloads must map a versioned public schema into the same
  `IssueObservation`; chat messages enter only through that schema and never spawn a
  separate session engine. The existing source HTTP API and Self-Healing source
  health view expose all implementations uniformly.
- **Acceptance** — Positive: `workTrackerIssueSources.conformance.test.ts` runs the
  lifecycle suite against all three transports and proves equivalent normalized
  findings, idempotent provider mutations, authoritative readback, and recovery
  after a dropped notification. **Required negative control:** replay one external
  object through two deliveries and then return a conflicting provider revision;
  prove one loop is retained, the conflict becomes visible drift, and no adapter
  reports `verified_closed` without matching readback.
- **Deps** — bh-1, bh-3, bh-7, bh-12; SP-3 and SP-8.
- **Migration** — none; reuse source, webhook, finding, loop, and outbox tables.
- **Size** — ~950 non-generated lines.
- **Order** — wave 4; it is parallel with the other source families and consumes the
  same frozen source contract.

## bh-23 — SARIF security finding source adapter

- **id**: `bh-23` · **name**: SARIF security finding source adapter
- **What** — Implement a SARIF 2.1.0 ingestion adapter behind
  `IssueSourceAdapter` that normalizes tool/rule identity, severity, CWE/tags,
  locations, code flows, artifact/source revision, and result fingerprints into
  immutable findings. It compiles static disappearance and declared exploit or
  invariant checks into the locked `SymptomContractV1`; native `.tanren/ci.yml`
  produces the static proof unit, while preview/production SP-5 evidence controls
  resolution. Findings, rule metadata, and proof links are callable and visible in
  loop detail without delegating delivery to a forge workflow.
- **Acceptance** — Positive: `sarifIssueSourceAdapter.integration.test.ts` ingests a
  multi-location code-flow result, deduplicates an equivalent rerun, routes a native
  repair spec, and proves the corrected exact revision has both a passing native
  static proof and required runtime invariant evidence. **Required negative
  control:** remove the SARIF result while the runtime exploit/invariant still fails
  and prove the green static result cannot authorize resolution or source closure.
- **Deps** — bh-4, bh-7, bh-15, bh-18; rv-14; SP-5 and SP-7.
- **Migration** — none; SARIF details are normalized into immutable
  `source_findings.context` and evidence bytes live only in SP-3.
- **Size** — ~800 non-generated lines.
- **Order** — wave 4; the adapter depends on locked behavior loading and preview
  verification so static disappearance cannot become a false close.

## bh-24 — Dependency and advisory source policy

- **id**: `bh-24` · **name**: Dependency and advisory source policy
- **What** — Add dependency inventory/advisory transports behind
  `IssueSourceAdapter` and a deterministic policy compiler in
  `engine/forge/dependencies/` that maps ecosystem, package, direct/transitive
  scope, semver/range, allowed replacement, grouping, maturity, registry, severity,
  and behavior/entity blast radius into P0/P1 upgrade specs and DAG edges. Lockfile
  and post-upgrade commands run only in the native gate; deployed behavior evidence
  remains the resolution criterion. Policy receipts and grouped findings are
  exposed through source administration and a dependency panel in Self-Healing.
- **Acceptance** — Positive: `dependencySourcePolicy.integration.test.ts` feeds
  advisory and version findings for two ecosystems, proves deterministic grouping
  and ordering, executes the resulting specs through native gate plus preview
  verification, and closes only after production proof/readback. **Required
  negative control:** offer a disallowed major replacement with a passing package
  metadata check and prove policy compilation rejects it before spec creation; a
  lockfile-only green gate cannot close a behavior regression.
- **Deps** — bh-2, bh-7, bh-15, bh-18; mq-9; SP-1, SP-4, SP-5.
- **Migration** — `0113_dependency_source_policies.sql`: add
  `dependency_source_policies(org_id, project_id, id, revision, policy_digest,
selectors, grouping, maturity_rule, rollout_policy, created_at, superseded_at)`
  as immutable revisions with unique `(org_id, project_id, revision)`, composite
  org foreign keys, org index, and FORCE RLS.
- **Size** — ~950 non-generated lines.
- **Order** — wave 4; source normalization, native queue partitions, and preview
  proof are prerequisites for safe grouped upgrade work.

## bh-25 — Soak policy and proof grades

- **id**: `bh-25` · **name**: Soak policy and proof grades
- **What** — Implement the `soak` `ResolutionStage` in
  `verification/resolutionStages/` with an immutable policy that selects active,
  observational, or hybrid samples, required invariants, regions/cohorts, minimum
  sample counts, confidence calculation, and progress signals. It promotes proof
  grades only as `attested`, `observational`, `active_causal`, or
  `active_plus_soak`, feeds the grade and sample-root digest into the existing
  `ResolutionAuthority`, and exposes current samples/grade through issue-loop APIs
  and the evidence timeline. Silence and elapsed time are never proof.
- **Acceptance** — Positive: `resolutionSoakStage.integration.test.ts` records the
  required active and telemetry samples across two cohorts, survives worker restart,
  computes the deterministic sample-root, and upgrades an `active_causal` result to
  `active_plus_soak`. **Required negative control:** provide zero events, incomplete
  provider pagination, or a sample from the wrong release digest and prove the
  stage remains running/inconclusive, never emits a passing soak, and never advances
  `ResolutionAuthority`.
- **Deps** — bh-19, bh-21; bh-6 and bh-11; SP-3 and SP-5.
- **Migration** — `0114_resolution_soak.sql`: add
  `verification_soak_policies(org_id, project_id, id, revision, policy_digest,
mode, required_samples, cohorts, invariants, created_at)` and append-only
  `verification_soak_samples(org_id, project_id, id, verification_run_id,
release_instance_id, cohort, provider_cursor, observation_digest, verdict,
observed_at)` with composite org foreign keys, org indexes, immutability triggers,
  and FORCE RLS.
- **Size** — ~950 non-generated lines.
- **Order** — wave 5; it requires causal replay and telemetry observations and
  supplies a final grade to later rollout and certificates.

## bh-26 — Integration-batch symptom verification and bisect

- **id**: `bh-26` · **name**: Integration-batch symptom verification and bisect
- **What** — Bind locked symptom contracts to exact `integration_nodes`, execute
  their bh-18 preview proofs as part of the existing multi-member native gate, and
  adapt `engine/merge/ddmin.ts`, `quickXplain.ts`, and batch-bisector receipts to
  reduce a failing contract to the minimal causal member or interaction set. The
  result feeds the existing seven-way queue disposition and
  `MergeAuthorityV2`; it never lands or dequeues an unproven member. Contract
  bindings, tested subsets, and culprit sets are callable from merge-queue APIs and
  visible in queue and issue-loop graphs.
- **Acceptance** — Positive: `batchSymptomBisect.integration.test.ts` builds a
  three-member jj integration node where only the interaction of two members breaks
  a locked behavior, proves the preview gate fails, records tested subsets, returns
  the two-member minimal culprit set, and preserves the innocent member for normal
  authorization. **Required negative control:** inject a non-monotonic or
  infrastructure-only failure and prove the coordinator records
  inconclusive/infra-held instead of blaming a member, bypassing the contract, or
  landing the batch.
- **Deps** — bh-18; mq-2, mq-3, mq-5, mq-6, mq-7; rv-16; SP-3, SP-4, SP-5.
- **Migration** — `0115_integration_node_symptom_contracts.sql`: add append-only
  `integration_node_symptom_contracts(org_id, project_id, integration_node_id,
contract_id, contract_digest, behavior_context_digest, binding_digest,
created_at)` with an org-scoped composite primary key, composite org foreign keys,
  immutability trigger, org index, and FORCE RLS; subset proofs remain in SP-3.
- **Size** — ~950 non-generated lines.
- **Order** — wave 5; exact preview proof must exist before the queue can attribute
  a runtime regression to a batch member or interaction.

## bh-27 — Entity-scoped release health barriers

- **id**: `bh-27` · **name**: Entity-scoped release health barriers
- **What** — Add `ReleaseHealthBarrier` persistence and a queue admission predicate
  that translates a verified production regression into holds scoped to behavior
  revisions, semantic entities, dependency packages, environments, or rollout
  surfaces. `QueuePolicyV1` and integration-node claims evaluate this predicate
  before materialization; independent work continues. Only a fresh passing
  verification and authorized barrier-release decision clears the hold. Barrier
  APIs and Self-Healing/queue views expose scope, cause, affected nodes, and release
  evidence.
- **Acceptance** — Positive: `releaseHealthBarrier.integration.test.ts` records a
  production regression on one behavior/entity pair, blocks two matching queue
  nodes, admits an unrelated node, and releases the barrier only after the repaired
  artifact passes the locked contract. **Required negative control:** submit a
  passing generic gate, stale contract result, or cross-org verification and prove
  none clears the barrier; matching work cannot enter through the sequential or
  batch land path while the barrier is active.
- **Deps** — bh-11, bh-25, bh-26; mq-4, mq-9, mq-14; SP-1, SP-4, SP-5.
- **Migration** — `0116_release_health_barriers.sql`: add
  `release_health_barriers(org_id, project_id, id, issue_loop_id,
resolution_decision_id, environment, scope_kind, scope_key, state,
cause_verification_run_id, release_verification_run_id, created_at, released_at)`
  with unique active org/project/environment/scope, composite org foreign keys, org
  index, and FORCE RLS.
- **Size** — ~900 non-generated lines.
- **Order** — wave 6; reliable soak grades and batch attribution establish the
  evidence and semantic scope that the admission barrier consumes.

## bh-28 — Progressive rollout controller

- **id**: `bh-28` · **name**: Progressive rollout controller
- **What** — Add a durable rollout controller over the single SP-6
  `DeployAdapter.promote` lifecycle. A versioned rollout plan defines ordered
  cohorts/regions, exposure weights, entry/exit behavior contracts, soak policy,
  and artifact digest; `ResolutionDagWalker` advances one step only after exact
  preview/canary and step evidence passes. Progress, active cohort, proof grade, and
  blocked reason are callable through delivery/issue-loop APIs and visible on the
  release timeline.
- **Acceptance** — Positive: `progressiveRollout.integration.test.ts` advances a
  verified artifact through 5%, 25%, and 100% scripted cohorts, proving each step
  uses the same digest and has a passing contract/soak receipt before the next
  promotion. **Required negative control:** fail a required invariant at 25% and
  prove the controller halts before 100%, opens the scoped health barrier, and
  cannot advance from readiness, elapsed time, or a receipt for another digest.
- **Deps** — bh-18, bh-25, bh-27; mq-13; SP-5 and SP-6.
- **Migration** — `0117_release_rollouts.sql`: add
  `release_rollouts(org_id, project_id, id, issue_loop_id, release_instance_id,
plan_digest, state, current_step, created_at, completed_at)` and append-only
  `release_rollout_steps(org_id, project_id, rollout_id, ordinal, cohort,
exposure, verification_run_id, artifact_digest, decision, decided_at)` with
  composite org foreign keys, org indexes, immutable step receipts, and FORCE RLS.
- **Size** — ~950 non-generated lines.
- **Order** — wave 7; rollout consumes preview proof, soak grades, and health
  barriers and is built before rollback so rollback can reference its exact step.

## bh-29 — Verified-artifact traffic rollback

- **id**: `bh-29` · **name**: Verified-artifact traffic rollback
- **What** — Implement a fail-closed rollback decider and worker around the existing
  SP-6 `DeployAdapter.rollback`. It selects only a previously verified artifact for
  the same org/project/app/environment, checks rollback-safety metadata and
  irreversible migration flags, records an immutable decision, switches traffic,
  then re-runs the locked behavior and symptom contracts. Traffic rollback is the
  only immediate effect; source-code reverts are emitted as ordinary P0 specs for
  jj/`MergeAuthorityV2`. Rollback state and re-verification are exposed in delivery
  APIs and the loop timeline.
- **Acceptance** — Positive: `verifiedArtifactRollback.integration.test.ts` fails a
  rollout invariant, selects the prior verified digest, rolls traffic back, proves
  that digest is live and passes the locked contracts, and routes a separate code
  repair spec. **Required negative control:** mark the candidate prior artifact
  unverified or the release migration irreversible and prove no rollback call is
  issued, no source-code ref is mutated, and the loop enters `needs_attention` with
  the health barrier retained.
- **Deps** — bh-27, bh-28; bh-13; mq-13; SP-4, SP-5, SP-6.
- **Migration** — `0118_release_rollback_decisions.sql`: add append-only
  `release_rollback_decisions(org_id, project_id, id, issue_loop_id, rollout_id,
failed_release_instance_id, target_release_instance_id, input_snapshot_digest,
safety_classification, decision, verification_run_id, created_at)` with composite
  org foreign keys, immutability trigger, org index, and FORCE RLS.
- **Size** — ~850 non-generated lines.
- **Order** — wave 7 after bh-28; the rollback receipt binds the failed rollout step
  and the previously verified release rather than inventing a parallel deploy path.

## bh-30 — Cross-repository resolution loop

- **id**: `bh-30` · **name**: Cross-repository resolution loop
- **What** — Extend the `IssueLoop` aggregate and spec-origin planner so one finding
  links an ordered multi-project dependency DAG, one locked contract, and the exact
  required release instances for every affected component. Each repository follows
  the normal spec, jj, native-gate, `MergeAuthorityV2`, deploy, and verification
  path; `ResolutionAuthority` receives a composite SP-3 proof only after every
  required component is deployed and the end-to-end contract passes. The loop graph
  API and UI show per-project specs, merges, releases, and the aggregate closure
  gate.
- **Acceptance** — Positive: `crossRepositoryResolution.integration.test.ts` routes
  one finding into two dependent projects, lands and deploys both through their
  normal paths, runs the end-to-end contract against the paired release digests,
  and authorizes one source closure. **Required negative control:** pass and deploy
  the first project while leaving the second stale, and prove the aggregate remains
  blocked, no first-PR shortcut closes the source, and a cross-org project cannot be
  attached to the loop.
- **Deps** — bh-2, bh-11, bh-18, bh-25; in-17; mq-5, mq-11; SP-3, SP-4, SP-6.
- **Migration** — `0119_issue_loop_projects.sql`: add
  `issue_loop_projects(org_id, issue_loop_id, project_id, role, ordinal,
depends_on_project_id, created_at)` and
  `issue_loop_release_requirements(org_id, issue_loop_id, project_id,
release_instance_id, required_behavior_revision_ids, state, verified_at)` with
  composite org keys/foreign keys, uniqueness per loop/project and loop/release, org
  indexes, and FORCE RLS.
- **Size** — ~950 non-generated lines.
- **Order** — wave 8; the composite loop depends on reliable per-project rollout,
  verification, and rollback semantics.

## bh-31 — Failure-aware repair routing

- **id**: `bh-31` · **name**: Failure-aware repair routing
- **What** — Replace bh-13's repeated-signature hard stop with a deterministic
  failure-aware router that snapshots prior hypotheses, failure/evidence digests,
  affected entities, attempted decompositions, model/provider capabilities, token
  and cost buckets, and cross-repository placement. A routing Answerer must select a
  genuinely new hypothesis, decomposition, or eligible model route; the decision is
  schema-validated, persisted immutably, injected into the successor P0 spec, and
  scheduled through the normal `DagWalker`. The route history is callable and
  visible as repair lineage and organization-level efficacy input.
- **Acceptance** — Positive: `failureAwareRepairRouting.integration.test.ts` feeds
  two equal symptom signatures with distinct new evidence, proves the second route
  changes a declared hypothesis/decomposition dimension, creates one successor spec,
  and carries exact prior proof plus disjoint cost accounting. **Required negative
  control:** return the same hypothesis/model/decomposition with no new evidence and
  prove the router detects a fixed point, creates no duplicate spec, spends no
  writer budget, and records `needs_attention` instead of looping or applying an
  arbitrary attempt cap.
- **Deps** — bh-13, bh-25, bh-30; mq-10; SP-1, SP-2, SP-3, SP-5.
- **Migration** — `0120_remediation_route_decisions.sql`: add append-only
  `remediation_route_decisions(org_id, project_id, id, issue_loop_id,
remediation_attempt_id, prior_decision_id, input_snapshot_digest,
failure_signature, evidence_set_digest, hypothesis_digest, decomposition_digest,
model_route, decision, successor_spec_id, created_at)` with composite org foreign
  keys, uniqueness on org/attempt/input snapshot, immutability trigger, org index,
  and FORCE RLS.
- **Size** — ~950 non-generated lines.
- **Order** — wave 8; complete single- and multi-repository evidence histories are
  required before the router can prove a route is materially new.

## bh-32 — Signed resolution certificate

- **id**: `bh-32` · **name**: Signed resolution certificate
- **What** — Replace bh-14's minimal resolution projection with a canonical
  `tanren-resolution-proof.v1` profile over the sole SP-3 `ProofSubstrate`. The
  certificate hash-links source signature/revision, issue loop, task/model/token/cost
  facts, locked contract/context/fragments, baseline, gate bundle,
  `MergeAuthorityV2` audit, merge SHA, release/artifact digest, preview/production/
  counterfactual/soak assertions, rollback or rollout receipts, the sole
  `ResolutionAuthority` decision, and source mutation/readback. The existing proof
  HTTP route serves schema, canonical envelope, signature/key ID, and redacted
  archive references; Self-Healing displays signature and completeness status.
- **Acceptance** — Positive: `resolutionCertificate.integration.test.ts` seals a
  complete single-repository and cross-repository resolution through
  `PgProofSubstrate`, reloads it, verifies the signature/root/bindings, and proves
  every required link resolves to the exact org-scoped fact. **Required negative
  control:** alter the merge SHA, artifact digest, assertion set, authority version,
  or source readback and prove verification fails and the API/UI never label the
  certificate valid; no second signing implementation or unsigned fallback exists.
- **Deps** — bh-19, bh-20, bh-25, bh-26, bh-29, bh-30, bh-31; bh-14; rv-24;
  `contracts/cas.ts` `ProofSubstrate`; SP-3, SP-4, SP-7.
- **Migration** — none; persist the certificate as the resolution profile in
  existing `proof_units`, `proof_bundles`, bundle membership, SP-3 CAS, and bh-14
  resolution-proof projection.
- **Size** — ~850 non-generated lines.
- **Order** — wave 9; the certificate schema is frozen only after every fact family
  it seals has a stable contract and receipt.

## bh-33 — Resolution proof verification CLI

- **id**: `bh-33` · **name**: Resolution proof verification CLI
- **What** — Add `tanren proof verify` and `tanren proof inspect` as resolution
  profiles in the existing CLI proof family. Offline verification parses the public
  schema, canonicalizes through `contracts/cas.ts`, verifies the Ed25519 envelope,
  root/member hashes, event ordering, authority versions, exact merge/deployment
  identities, assertion completeness, proof-grade requirements, and source
  readback; online mode fetches the same envelope from the existing proof route and
  resolves public signing keys. Output supports human text and stable JSON and is
  linked from Self-Healing certificate detail.
- **Acceptance** — Positive: `proofVerify.cli.integration.test.ts` exports a bh-32
  certificate, verifies it offline and online, and asserts identical structured
  results including the resolution policy and evidence completeness. **Required
  negative control:** remove one required assertion, reorder an impossible lifecycle
  transition, or substitute a valid certificate from another org/project and prove
  a non-zero exit with a typed reason; `--offline` never trusts the server verdict.
- **Deps** — bh-32; rv-24 CLI proof framework; SP-3.
- **Migration** — none; CLI reads the public schema/envelope and existing proof/key
  endpoints.
- **Size** — ~750 non-generated lines.
- **Order** — wave 9 after bh-32; the command implements the frozen certificate
  profile rather than defining a competing proof format.

## bh-34 — Resolution fleet analytics

- **id**: `bh-34` · **name**: Resolution fleet analytics
- **What** — Build an org-scoped projection from existing immutable findings,
  attempts, verification runs, routing decisions, releases, barriers, authority
  decisions, source readbacks, costs, and proof bundles. It computes verified-fix
  rate, first-pass live success, false-green catches, time to reproduction and
  verification, repair depth, recurrence, provider-sync delay, verification flake,
  cost per verified resolution, model-route efficacy, and behavior/entity hot spots.
  A startup/periodic projector uses event cursors only as wake hints, HTTP endpoints
  return filterable aggregates with fact watermarks, and the Self-Healing fleet view
  displays drill-down links to source proof.
- **Acceptance** — Positive: `resolutionFleetAnalytics.integration.test.ts` seeds
  multiple projects, providers, proof grades, retries, and costs, rebuilds the
  projection after restart, and proves every aggregate equals a direct immutable-fact
  calculation and drills down to its certificate. **Required negative control:**
  inject a merged-but-unverified attempt and an authorized decision without source
  readback and prove neither counts as a verified fix; cross-org facts return zero
  and cannot influence another org's rates.
- **Deps** — bh-21..25, bh-30, bh-31, bh-32; canonical cost ledger; SP-3 and SP-8.
- **Migration** — `0121_resolution_metric_rollups.sql`: add mutable projection
  `resolution_metric_rollups(org_id, project_id, period_start, period_kind,
dimensions_digest, dimensions, measures, source_event_watermark, computed_at)`
  with primary key `(org_id, project_id, period_start, period_kind,
dimensions_digest)`, composite org foreign keys, org index, and FORCE RLS. The
  table stores rebuildable aggregates only; immutable proof remains in SP-3.
- **Size** — ~950 non-generated lines.
- **Order** — wave 9; analytics consumes the complete provider, routing, rollout,
  cross-repository, certificate, and cost fact set.

## bh-35 — Live resolution conformance burn-in

- **id**: `bh-35` · **name**: Live resolution conformance burn-in
- **What** — Add a scheduled, org-scoped conformance runner that drives the public
  source, project, issue-loop, proof, and deploy APIs against provider sandbox
  accounts and ordinary tenant projects. A versioned scenario matrix covers signed
  duplicate intake, baseline reproduction, ineffective and effective repairs,
  preview/batch proof, rollout/rollback, counterfactual, soak, source readback,
  restart recovery, drift reconciliation, credential rotation, rate limits, and
  proof verification. It uses normal containers, writers/answerers, jj,
  `.tanren/ci.yml`, `MergeAuthorityV2`, SP-6 adapters, and `ResolutionAuthority`;
  conformance status and signed run proof are callable and visible in operations UI.
- **Acceptance** — Positive: `just smoke-resolution-conformance` runs the hermetic
  provider-neutral matrix, and the live scheduled job completes the configured
  source/deploy adapter matrix for consecutive cycles while producing a bh-32
  certificate for each scenario and a bh-33-valid aggregate manifest. **Required
  negative control:** inject dropped notifications, a worker restart between
  verification and source sync, provider readback drift, and a semantic HTTP-200
  regression; prove recovery is exactly once, drift stays open, the semantic defect
  blocks closure, and the run fails loudly if any adapter or proof step is skipped.
- **Deps** — bh-15..34; in-20, in-21; rv-1..19, rv-24, rv-25; SP-1..8.
- **Migration** — `0122_resolution_conformance_runs.sql`: add
  `resolution_conformance_runs(org_id, project_id, id, scenario_version,
source_adapter_kind, deploy_adapter_kind, state, claim_owner, claim_expires_at,
progress_digest, proof_bundle_id, started_at, completed_at, failure)` and
  append-only `resolution_conformance_steps(org_id, project_id, run_id, ordinal,
step_kind, input_digest, output_digest, verdict, observed_at)` with composite org
  foreign keys, unique scenario idempotency, immutable step receipts, org indexes,
  and FORCE RLS.
- **Size** — ~950 non-generated lines.
- **Order** — wave 10; this is the final general-system acceptance node and runs only
  after every adapter, authority input, proof profile, CLI verifier, and analytics
  projection is callable through its delivered surface.
