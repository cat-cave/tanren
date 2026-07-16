<!-- cspell:ignore mqeval mqgrp -->

# mq-2 — exact multi-member MergeAuthority evaluation

**Phase**: MVP (merge-queue)  
**Node ID**: `mq-2`  
**Base**: `origin/main` @ `608c5bbc08728dfa0188a2d1a0408688f0e76876` (#962 MQ-1)  
**Branch**: `mission/mq-2-final`  
**Node credit**: **0** until independent audit, full green gates, and merge

## Purpose and boundary

MQ-2 evaluates the exact persisted `merge_batch` integration node through the
merged SP-4 `MergeAuthorityV2` before the production coordinator embarks on
member lands. It produces the closed seven-way consumer disposition
(`authorized_subset`, `member_failure`, `interaction_failure`,
`flake_observation`, `transient_infrastructure`, `needs_product_decision`, or
`unknown_fail_closed`), preserves member attribution, and exposes a durable-state
HTTP/UI read side.

This node does **not** solve subsets. `authorized_subset` means that the exact
provided node (possibly a solver-provided subset in the future) was authorized;
MQ-2 never manufactures a new subset head. A mixed node can identify failed
members and dependency-held members, while all actual lands still re-authorize
through the sole SP-4 land path. Generalized subset search belongs to MQ-3;
partition leases to MQ-4; atomic group land to MQ-5; arbitrary subset
materialization to MQ-11.

## Consumes — never redefine

- SP-4 `MergeAuthorityV2`, frozen `AuthorizeLandInput`,
  `LandBindingEnvelope`, and `LandMemberDisposition`.
- SP-3 `Digest` and the frozen six-component integration proof identity.
- Existing `integration_nodes` / `integration_proofs` durable state.
- MQ-1 W0 `merge.signal.classified` and
  `merge.member.policy_blocked` schemas and sole `EventStore` path.
- Existing native batch gate and sequential per-member authority land path.

**No migration and no event-registry edit.** W0 durably proves the four
classifiable signal arms (member policy, infra, product decision, unknown).
`authorized_subset`, `interaction_failure`, and `flake_observation` are honest
engine/HTTP/UI dispositions reconstructed from canonical integration-node,
proof, batch-event, quarantine, and authority-decision state; this PR does not
claim unfrozen W3 event names.

## Exact ownership

### Exclusive / new

- `docs/roadmap/mission-complete/nodes/cards/mq-2.md`
- `services/orchestrator/src/engine/merge/multiMemberAuthorityTypes.ts`
- `services/orchestrator/src/engine/merge/multiMemberAuthorityEvaluator.ts`
- `services/orchestrator/src/engine/merge/multiMemberAuthorityGatherPg.ts`
- `services/orchestrator/src/engine/merge/authoritySignalIdentity.ts`
- `services/orchestrator/src/routes/mergeQueue/authorityEvaluations.ts`
- `services/dashboard/src/api/mergeQueueAuthorityEvaluations.ts`
- `services/dashboard/src/components/mergeQueue/MultiMemberAuthorityPanel.tsx`
- `services/orchestrator/tests/multiMemberAuthorityEvaluator.test.ts`
- `services/orchestrator/tests/mq2BatchAuthorityCutover.test.ts`
- `services/orchestrator/tests/mergeQueueAuthorityEvaluationsRoutes.test.ts`
- `services/orchestrator/tests/mergeQueueAuthorityEvaluations.rls.integration.test.ts`
- `services/dashboard/tests/multiMemberAuthorityPanel.render.test.ts`

### Thin shared-file leases

- `engine/contracts/batchMergeCoordinator.ts`: carry exact persisted-node
  binding on integrated verdicts; no solver API.
- `engine/merge/batchIntegrationNodeDrive.ts`: attach the node identity/head and
  proof binding produced by the existing gate path.
- `engine/merge/batchCoordinator.ts`: mandatory evaluator call before embark;
  no inline evaluator logic (file cap).
- `engine/merge/batchCoordinatorBuild.ts`: wire the production PG evaluator.
- `engine/merge/authoritySignalClassification.ts`: extract shared identity and
  admit explicit validated multi-member policy attribution.
- `routes/experiments/mount.ts`: mount the read-only evaluation routes.
- Dashboard merge-queue route/body: fetch and compose one panel only.
- Existing focused batch/classifier tests only where their seam changes require
  fixture updates.

### Hard exclusions

- `db/migrations/**`, event registry/seed/sensitivity/JSON contracts.
- Frozen spine contract shapes, especially `mergeAuthority.ts`, `cas.ts`, and
  `gateProof.ts`.
- New land/store/byte-store authority, direct host land, or bypass endpoint.
- `batchChecker.ts` credential hunks and `mergeAuthorityBundleBuild.ts` (IN-1
  lease); IN-1/RV-4/GV-1/#856 paths generally.
- MQ-3 ddmin/QuickXPlain, learned failure constraints, or maximal-safe solver.
- Shared navigation / `screens.ts` / migrations.

## Acceptance and proof matrix

1. A production batch verdict carries the exact persisted integration-node
   identity, ordered real run/spec/branch/head members, base/head SHA, policy,
   and proof key; missing or mismatched identity fails closed.
2. The coordinator calls the MQ-2 evaluator before any `driveMerge`; only an
   exact `authorized_subset` or an attributed `member_failure` may continue to
   per-member re-authorization. Unknown/product/flake outcomes do not false-land;
   existing interaction/infra settlement remains typed and non-blaming.
3. All-clean multi-member input calls the real `MergeAuthorityV2.authorizeLand`
   once and returns `authorized_subset` for the exact full node. Evaluation never
   calls `land` or advances the host.
4. Member-local policy returns `member_failure` with exact member/finding IDs,
   emits canonical W0 facts, never emits infra, and leaves independent siblings
   eligible for their own fresh authority lands.
5. Combined-tree failure after clean member preflight is
   `interaction_failure`; typed same-tree non-determinism is
   `flake_observation`; neither blames a member or starts MQ-3 search.
6. Typed infrastructure, product-decision, and untyped/contradictory evidence
   map only to their corresponding closed dispositions.
7. Evaluation/group IDs are deterministic `mqeval_`/`mqgrp_`; member order,
   base/head, proof/policy, and authority reasons are identity-load-bearing.
8. GET list/detail routes are org/project authorized and RLS-scoped. They read
   canonical durable state (W0 facts/current integration nodes/proofs/authority
   decisions), never a process-local cache; cross-org returns indistinguishable
   404.
9. The existing merge-queue screen renders the seven-way state and ordered
   member outcomes; unavailable/empty state is explicitly unknown, never green.
10. Mutation-sensitive tests cover mixed policy, all clean, interaction, flake,
    infra, product decision, unknown, tenant isolation, replay/freshness, stable
    identity, and no host-land call.
11. `just affected-typecheck`, focused/affected tests, `just fast-check`,
    `just ci`, and `just smoke` are green at the candidate SHA; source files stay
    at or below 500 lines.

## Anti-cosplay rules

- No second enum masquerading as SP-4 `LandDecision`; the seven-way type is a
  consumer evaluation mapped onto the unchanged authority.
- No `authorized_subset` for a head that contains excluded members.
- No caller-supplied policy labels as evidence; findings/review/gate state come
  from durable per-run records and the exact batch proof.
- No in-memory projection, generic event substitute, or claim that unfrozen W3
  events landed.
- No merge-on-evaluate. Every actual member land revalidates freshness and runs
  the sole `MergeAuthorityV2.land` protocol.
