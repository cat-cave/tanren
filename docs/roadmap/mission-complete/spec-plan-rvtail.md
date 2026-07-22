# Runtime-verification tail build plan

This plan closes the three remaining runtime-verification nodes without adding a
fixture-specific product path. The behavior-gated fixture used by rv-26 enters through
the same onboarding, DAG, native-gate, merge-authority, deploy, re-proof, and demo
contracts available to every organization and project.

## Node roster

| Order  | ID    | Name                                                             | Decision                                  | Migration | Size          |
| ------ | ----- | ---------------------------------------------------------------- | ----------------------------------------- | --------- | ------------- |
| Wave 1 | rv-20 | Behavior-attempt CI compatibility projection                     | Build as a standalone projection consumer | 0111      | 550–750 lines |
| Wave 1 | rv-21 | Forge interview completion and DesignContract synthesis consumer | Build the missing public-route consumer   | None      | 650–900 lines |
| Wave 2 | rv-26 | Normal-pipeline behavior-verification closure                    | Acceptance node; no new engine path       | None      | 450–700 lines |

## rv-20 — Behavior-attempt CI compatibility projection

**id** — rv-20; **name** — Behavior-attempt CI compatibility projection.

**What** — Add an idempotent, append-only projection writer beside
`recordAttemptRow` in
`services/orchestrator/src/engine/verification/acceptance/attemptLifecycle.ts` that
writes exactly one `ci_test_results` row for every persisted
`behavior_verification_attempts` row in the same org-scoped transaction. The stable
`test_id` is
`behavior:<behavior_revision_id>:<example_hash>:<matrix_hash>`; `suite` is
`runtime-behavior`; `head_sha` comes from the owning
`behavior_verification_runs.prepared_head_sha`; duration comes from the attempt
timestamps; and outcomes map `passed` to `passed`, product/contract/visual failures to
`failed`, infrastructure/external inconclusive outcomes to `error`, and superseded
cancellation to `skipped`. Migration 0111 extends the schema in
`db/src/schemaInsights.ts` so a row declares `source_kind = native_ci |
behavior_verification`, points directly to its org-scoped behavior run and attempt,
and does not fabricate a workflow `runs.run_id` for manual or production re-proof
attempts. Existing readers such as
`services/orchestrator/src/engine/insights/ciFlaky.ts`, JUnit export, and
`services/orchestrator/src/engine/verification/acceptance/completenessInvariant.ts`
continue to read the compatibility table; the completeness reader replaces its
workflow-member join with the new direct behavior-run/attempt referents. Behavior
plans, attempts, observations, verdicts, and proof bundles remain the sole truth for
behavior gating.

**Acceptance** — A real-Postgres integration test creates one run-bound attempt and
one manual-canary attempt through the production attempt/verdict transaction, then
proves that each produces one org-scoped compatibility row with the exact stable
identity, normalized outcome, head, duration, and source referents; replaying the
write produces no duplicate, native JUnit ingestion remains unchanged, the existing
CI-flake reader can consume the projected history, and
`PgAcceptanceCompletenessChecker` passes only when its first-class plan/verdict/proof
checks also pass. **Required negative control:** delete the compatibility row, insert
one with a foreign-org attempt, or retry with a different normalized result for the
same attempt; the completeness check must return
`ci_compat_projection_missing`, RLS/FKs must reject the cross-org row, and the
idempotency conflict must fail loudly rather than overwrite history or report green.

**Deps** — rv-10 attempt and verdict persistence, migration 0037
`behavior_verification_attempts`/`behavior_verification_runs`, migration 0110
`acceptance_completeness_projection`, the existing `ci_test_results` schema and
org-scoped transaction helper, and the `eventStore.ts` sole-event-writer invariant.
The projection emits no second behavior lifecycle event; first-class runtime events
remain authoritative.

**Migration** — 0111 alters `ci_test_results`: add non-null `source_kind` with
`native_ci` default and a check over `native_ci | behavior_verification`; add nullable
`behavior_verification_run_id` and `behavior_attempt_id`; make legacy `run_id`
nullable; add composite `(org_id, behavior_verification_run_id)` and `(org_id,
behavior_attempt_id)` foreign keys; add a partial unique index on `(org_id,
behavior_attempt_id)` for behavior projections; and add a source-shape check requiring
native rows to have `run_id` and no behavior referents while behavior rows have both
behavior referents and may carry a workflow `run_id`. Reassert `ENABLE ROW LEVEL
SECURITY`, `FORCE ROW LEVEL SECURITY`, and the org policy with both `USING` and `WITH
CHECK`; update the Drizzle schema and migration journal in the same node.

**Size** — 550–750 non-generated lines: approximately 120 schema/migration lines,
180 projection and mapping lines, and 250–450 unit, real-Postgres RLS, idempotency, and
reader-regression test lines.

**Order** — Build wave 1. rv-10 and migration 0110 already exist, and rv-20 has no
dependency on rv-21. It must land before rv-26 because the closure invariant requires
a non-zero compatibility read surface but forbids that surface from substituting for
first-class behavior proof.

## rv-21 — Forge interview completion and DesignContract synthesis consumer

**id** — rv-21; **name** — Forge interview completion and DesignContract synthesis
consumer.

**What** — Turn the existing interview/design spine into a callable consumer through
`POST /v1/orgs/:orgId/onboarding/interview/round` and
`POST /v1/orgs/:orgId/onboarding/interview/derive` in
`services/orchestrator/src/routes/onboarding/index.ts`. Add one deterministic
`InterviewCompletion` predicate in `engine/forge/interview/` and invoke it from both
`runRound` in `engine.ts` and the derive boundary: completion requires identity, at
least one persona, at least one Given/When/Then behavior whose persona resolves, at
least one declared interface, an explicit domain-general design seed, architecture,
and lifecycle; empty rulesets remain a valid explicit result. If an Answerer claims
completion early, the round stays incomplete and returns typed missing capture areas
for the next question. A complete capture flows through
`buildDerivationDesignPlan`, the production `DesignAgent` from
`routeFactories.ts`, `providerDesignResult`, and `DesignContractStore.create` in
`deriveDesignContract.ts`, producing a project-scoped, versioned `DesignContractV1`
whose digest and persona/behavior coverage refer to the exact entities created by
`deriveEntityGraph.ts`; the public derive response exposes its id, version, domain,
and digest for downstream rv-13 rendered verification.

**Acceptance** — A route-level real-Postgres test drives multiple interview rounds
through the mounted onboarding HTTP routes with an injected strict-schema Answerer,
including a design-light non-web project, then derives the project and proves the
returned contract digest matches the stored HEAD, every persisted persona and
behavior is covered by the synthesized contract, the behavior references resolve to
the newly created behavior identities and their immutable current revisions, and
rv-13 can load that exact contract for rendered verification. **Required negative
control:** an Answerer returns
`complete: true` while omitting the design seed and while naming an unknown persona
or behavior; the round must return `complete: false` with typed missing/invalid areas,
direct derive must return a typed 409 without creating a repository, project, or
design-contract row, and no captured reference may be silently dropped.

**Deps** — rv-1 immutable behavior revisions, rv-13 DesignContract/render consumer,
the existing `InterviewCapture`, `InterviewRoundOutput`, `DesignAgent`,
`DesignContractV1`, `DesignContractStore`, project-derivation receipt, and onboarding
authorization contracts. Both required runtime nodes and their migrations already
exist.

**Migration** — None. Interview state remains client-carried by contract; the
project-scoped `design_contracts` store and derivation receipt already provide the
durable, org-scoped result.

**Size** — 650–900 non-generated lines: approximately 150 completion-contract and
error-mapping lines, 100 engine/route wiring lines, and 400–650 route, synthesis,
real-Postgres RLS, rollback, and downstream-load test lines.

**Order** — Build wave 1 in parallel with rv-20. Its rv-1/rv-13 contracts already
exist and it owns no migration. It must land before rv-26 so the closure run proves
that executable behavior and rendered design obligations originate in a normal Forge
interview instead of being inserted directly.

## rv-26 — Normal-pipeline behavior-verification closure

**id** — rv-26; **name** — Normal-pipeline behavior-verification closure.

**What** — Close the runtime program by driving a behavior-gated fixture through
Tanren's normal public onboarding and autonomous delivery pipeline; this node creates
no workflow kind, mode flag, fixture-named contract, private scheduler, or second
proof authority. The production-path audit finds no rv-26-specific engine gap after
the merged Phase-1 event producers, migration 0110 completeness invariant,
`BrowserAcceptanceSurfaceDriver`, and behavior-aware bisection events; rv-20 and
rv-21 are the two remaining general prerequisites and are earlier nodes, not hidden
work. Done means one normal run and its adversarial child changes exercise: Forge
behavior revisioning and DesignContract synthesis; deterministic non-empty plan
compilation; missing-fragment F2 author/validate/recompose with a sensitivity control;
exact jj integration-node materialization; immutable artifact build and preview
deployment; browser actions through `AcceptanceSurfaceDriver`; application receipts
and a real `SideEffectObserverAdapter`; exact trigger/effect cardinality and
correlation; rendered DesignContract capture and deterministic verdict; non-zero
assertion-bearing attempts and verdicts; rv-20 compatibility rows; the engine-owned
native gate and signed `GateProofBundleV2`; behavior-aware batch/subset bisection;
`MergeAuthorityV2` authorization of the exact node; promotion of the proven digest;
production re-proof; and proof-backed demo evidence visible through the existing
runtime-verification/proof-dashboard HTTP and CLI readers.

**Acceptance** — From a clean stack and ordinary tenant credentials, use only public
HTTP/CLI surfaces to interview, derive, and run a fixture whose declared behavior
requires a browser interaction, an externally observed effect, and a rendered design
checkpoint. The positive proof must show the exact chain
`behavior revision -> compiled plan/validated fragments -> jj node -> artifact digest
-> preview -> actions/receipts/effects/render -> non-zero passed verdicts -> native
gate bundle -> MergeAuthorityV2 decision -> same-digest promotion -> production
re-proof -> proof-backed demo`, with all registered lifecycle events appended through
`eventStore.ts`, exact required-plan-verdict set equality from migration 0110, a
non-zero rv-20 projection, and independent reads from the public proof surfaces. The
same acceptance run must execute these required negative controls through normal child
specs/nodes: remove the expected external effect and block merge; alter a required
rendered state and route the deterministic failure to DesignOracle; include a bad
member in a multi-member batch and identify it by recorded bisection; split a defect
across two individually passing members and return the minimal interaction set;
corrupt a verification fragment and route to F2 without blaming product code; deny an
external observer and block as inconclusive without culprit attribution; attempt a
cross-org proof/artifact read and receive denial; replay a bundle against a different
tree/artifact/deployment or expired context and have `MergeAuthorityV2` reject it;
attempt baseline approval as the implementing actor and receive policy denial; and
remove production proof evidence so the demo is unverified rather than falling back
to a transport probe. No database write, direct git mutation, internal route, or
hand-fix of the fixture may satisfy either the positive proof or a control.

**Deps** — rv-1 through rv-19, rv-24, rv-25, rv-20, and rv-21; migration 0110; the
8-contract spine; `WorkspaceVcsCore`; `DagWalker`; `AcceptanceSurfaceDriver` with its
HTTP/browser implementations; `FixtureLeaseAdapter`; `SideEffectObserverAdapter`;
`GateProofBundleV2`; `MergeAuthorityV2`; jj `integration_nodes`; native
`.tanren/ci.yml` gates; deploy promote/re-proof; proof-backed demo; registered runtime
event schemas; public proof readers; and org-scoped RLS/object authorization. Every
dependency is merged or lands in wave 1.

**Migration** — None. The fixture must prove the existing first-class behavior,
evidence, gate, proof, merge, release, and event stores. Adding a fixture-status table
would create a second proof store and is forbidden.

**Size** — 450–700 non-generated lines, confined to reusable live-validation
assertions, fixture-owned behavior/gate declarations, and operator documentation;
zero new production engine branches. The node closes only when the production paths
listed in **What** pass the positive proof and every negative control.

**Order** — Build wave 2 after rv-20 and rv-21. The order is dependency-driven: the
run must originate its behavior/design obligations through the completed interview
consumer and must satisfy the compatibility portion of the promotion completeness
invariant. Completion requires the positive chain and every negative control above in
one recorded validation campaign; isolated unit evidence does not close rv-26.
