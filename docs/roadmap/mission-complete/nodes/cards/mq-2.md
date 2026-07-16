<!-- cspell:ignore mqeval mqgrp -->

# mq-2 — exact multi-member MergeAuthority evaluation

**Phase**: MVP (merge-queue)  
**Node ID**: `mq-2`  
**Base**: `origin/main` @ `26aabe6f` (#969 RV-4; re-ported over post-in-1/rv-4/mq-1)  
**Branch**: `mission/mq-2-final`  
**Node credit**: **0** until independent audit, full green gates, and merge

## Purpose and boundary

MQ-2 evaluates the exact persisted `merge_batch` integration node through the
merged SP-4 `MergeAuthorityV2` before the production coordinator embarks on
member lands. The closed seven-way consumer disposition is
(`authorized_subset`, `member_failure`, `interaction_failure`,
`flake_observation`, `transient_infrastructure`, `needs_product_decision`, or
`unknown_fail_closed`); it preserves member attribution and exposes a
durable-state HTTP/UI read side.

**Two of the seven are durable read-side reconstructions, not post-pass engine
dispositions.** The pre-embark evaluator runs ONLY after an integrated PASS, so it
genuinely produces five embark/W0 dispositions — `authorized_subset` (derived from
a real SP-4 `decision === "authorized"` on a genuinely-clean input, never from the
absence of a fail-closed classification), `member_failure`,
`needs_product_decision`, `transient_infrastructure`, and `unknown_fail_closed` (a
residual non-attributable authority block is `unknown_fail_closed`, never
`interaction_failure`). The remaining two are reconstructed solely by the HTTP read
side (`readDurableBatchEvidence`) from durable state a passing pre-embark evaluator
cannot witness: `interaction_failure` from a durable FAILED batch `integration_proof`
(`batch_gate.v1`), and `flake_observation` from a durable ci-flaky `quarantined_tests`
row whose proven toggle attests THIS exact head at the matching quarantine epoch.
There is no synthesized pre-authority flake input and no dead engine branch.

This node does **not** solve subsets. `authorized_subset` is the primary kind
only when SP-4 authorizes the exact full member set represented by the persisted
input node (or, in the future, an exact solver-provided node) with every member
`admit`. MQ-2 never drops members while reusing the old head and never
materializes an admitted-only head. Mixed member-local policy is therefore
`member_failure`, not `authorized_subset`: failed members are withheld, while
survivors are only eligible for fresh sequential per-member re-authorization.
That eligibility is not proof that a multi-member remainder was authorized.
Generalized subset search belongs to MQ-3; partition leases to MQ-4; atomic
group land to MQ-5; arbitrary subset materialization to MQ-11.

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

W0 emissions retain the frozen literal `missionNodeId: "mq-1"`. MQ-2 may lift
MQ-1's single-member policy guard only for validated, non-empty per-member
attribution with non-empty finding IDs; an unattributed multi-member policy
block remains `unknown_fail_closed` / `unattributed_policy`. Batch order is
never evidence of member blame.

## Durable evidence adjudication

- The native integrated gate remains the sole proof writer. Its existing
  `integration_proofs.evidence` JSONB now carries strict `batch_gate.v1`
  evidence bound to node, head, tree, ordered member-set hash, verdict, and all
  six proof-key inputs. Missing, partial, stale, or mismatched evidence is
  `unknown_fail_closed`; a verdict label alone proves nothing.
- The active quarantine epoch is the content hash of the exact active check/test
  exclusions. The batch gate actuates that same set and app-env. Flake projection
  additionally requires canonical `quarantined_tests.evidence` naming the exact
  proven head; a changed epoch or malformed row assigns no flake state.
- A failed exact multi-member proof is durably visible as a no-blame
  `interaction_failure` while the existing coordinator performs its typed
  bisect. The post-pass evaluator still accepts only an exact proof-derived
  pass/clean/resolved state; a proof race fails closed instead of inheriting
  hard-coded green inputs.
- W0 policy rows recover ordered members, independent survivors, and transitive
  dependency holds only when the stable group ID matches one exact persisted
  node and every member's persisted spec-DAG row decodes. W0 does not bind a
  proof epoch, so this projection deliberately leaves `proofReuseKey` null.

### `authorized_subset` reachability

`MergeAuthorityV2.authorizeLand` is deliberately read-only and persists no
decision. The current real land path persists only after a fresh sequential
per-member authorization, whose subject is not the multi-member batch node.
Therefore MQ-2 cannot honestly create an exact durable multi-member
`authorized_subset` footprint without inventing a second writer or changing the
frozen land protocol. The strict read-side accepts such a footprint if a future
MQ-5 group land persists it, but today it remains empty/unknown. MQ-2 completion
instead requires the real pre-embark SP-4 call to authorize the exact full set,
an all-`admit` engine disposition, and the proven embark filter/effect. An empty
HTTP `authorized_subset` projection is complete honesty and does not block MQ-2
credit; MQ-3 owns subset selection and MQ-5 owns durable group-land liveness.

## Exact ownership

### Exclusive / new

- `docs/roadmap/mission-complete/nodes/cards/mq-2.md`
- `services/orchestrator/src/engine/merge/multiMemberAuthorityTypes.ts`
- `services/orchestrator/src/engine/merge/multiMemberAuthorityEvaluator.ts`
- `services/orchestrator/src/engine/merge/multiMemberAuthorityEmbark.ts`
- `services/orchestrator/src/engine/merge/multiMemberAuthorityGatherPg.ts`
- `services/orchestrator/src/engine/merge/multiMemberAuthorityPgAuthority.ts`
- `services/orchestrator/src/engine/merge/multiMemberAuthorityPgHost.ts`
- `services/orchestrator/src/engine/merge/multiMemberAuthorityPgState.ts`
- `services/orchestrator/src/engine/merge/multiMemberAuthorityEvidence.ts`
- `services/orchestrator/src/engine/merge/multiMemberAuthorityEvidencePg.ts`
- `services/orchestrator/src/engine/merge/authoritySignalIdentity.ts`
- `services/orchestrator/src/routes/mergeQueue/authorityEvaluations.ts`
- `services/orchestrator/src/routes/mergeQueue/authorityEvaluationEvidence.ts`
- `services/dashboard/src/api/mergeQueueAuthorityEvaluations.ts`
- `services/dashboard/src/components/mergeQueue/MultiMemberAuthorityPanel.tsx`
- `services/orchestrator/tests/multiMemberAuthorityEvaluator.test.ts`
- `services/orchestrator/tests/mq2BatchAuthorityCutover.test.ts`
- `services/orchestrator/tests/helpers/mq2BatchAuthority.ts`
- `services/orchestrator/tests/mergeQueueAuthorityEvaluationsRoutes.test.ts`
- `services/orchestrator/tests/mergeQueueAuthorityEvaluations.rls.integration.test.ts`
- `services/dashboard/tests/multiMemberAuthorityPanel.render.test.ts`

### Thin shared-file leases

- `engine/contracts/batchMergeCoordinator.ts`: carry exact persisted-node
  binding on integrated pass verdicts; no solver API.
- `engine/merge/batchIntegrationNodeDrive.ts`: attach the node identity/head and
  proof binding produced by the existing gate path, and persist the gate result in
  the existing `integration_proofs.evidence` JSONB (no second store).
- `engine/merge/batchNodeGate.ts`: actuate the exact active quarantine set while
  running the integrated gate. No new gate/event vocabulary.
- `engine/merge/batchChecker.ts`: only propagate each queue entry's real `runId`
  through the ordered-member/build-facts seam. IN-1 owns the adjacent org
  credential/static-ref resolution lines; its merge/rebase is a serialized
  convergence point and MQ-2 does not alter those hunks.
- `engine/merge/batchCoordinator.ts`: mandatory evaluator call before embark;
  no inline evaluator logic (file cap).
- `engine/merge/batchCoordinatorBuild.ts`: wire the production PG evaluator.
- `engine/merge/authoritySignalClassification.ts`: extract shared identity and
  admit explicit validated multi-member policy attribution.
- `routes/experiments/mount.ts`: mount the read-only evaluation routes.
- Dashboard merge-queue route/body: fetch and compose one panel only.
- Existing focused batch/classifier tests only where their seam changes require
  fixture updates.
- `tests/batchNodeGate.test.ts`: pin exact quarantine actuation at the shared gate
  seam.

### Hard exclusions

- `db/migrations/**`, event registry/seed/sensitivity/JSON contracts.
- Frozen spine contract shapes, especially `mergeAuthority.ts`, `cas.ts`, and
  `gateProof.ts`.
- `mergeAuthorityGate.ts` and its land protocol; serialize with future GV-2 on
  shared MergeAuthority land/review writers.
- New land/store/byte-store authority, direct host land, or bypass endpoint.
- `batchChecker.ts` org credential/static-ref hunks and
  `mergeAuthorityBundleBuild.ts` (IN-1 lease); IN-1/RV-4/GV-1/#856 paths
  generally.
- MQ-3 ddmin/QuickXPlain, learned failure constraints, or maximal-safe solver.
- Shared navigation / `screens.ts` / migrations.

## Acceptance and proof matrix

1. Multi-member evaluation binds `LandSubject` to
   `{ kind: "integration_node", id: integration_nodes.nodeId }`, never
   `land-${runId}`. Its envelope has ordered, real per-entry
   `runId`/`specId`/`branch`/`headSha` members (never a repeated `tailSpecId`).
   `BatchCheckVerdict.pass` carries `nodeId`, those ordered members, `baseSha`,
   `headSha`, `memberSetHash`, the exact proof-reuse key/components,
   `policyVersion`, and `integrationBranch`. Missing, stale, or mismatched
   identity fails closed and the coordinator does not embark.
2. The coordinator calls the MQ-2 evaluator after an integrated pass and before
   any `driveMerge`. `authorized_subset` may continue only for the exact all-
   `admit` node. On attributed `member_failure`, attributed members never
   embark; independent siblings may continue only through the existing
   sequential `driveMerge` path, whose sole SP-4 authority performs fresh
   per-land authorization/freshness checks. MQ-2 never advances main. The
   pre-MQ-5 mismatch between group proof and sequential lands is explicitly
   deferred; this node does not claim atomic group land or multi-member
   remainder authorization.
3. All-clean multi-member input calls the real `MergeAuthorityV2.authorizeLand`
   once and returns `authorized_subset` for the exact full node. Evaluation never
   calls `land` or advances the host.
4. Member-local policy returns primary kind `member_failure` with exact
   member/finding IDs, emits canonical W0 facts with frozen
   `missionNodeId: "mq-1"`, never emits infra, and leaves independent siblings
   eligible only for their own fresh authority lands. Multi-member policy with
   missing/empty attribution or finding IDs is `unknown_fail_closed` with
   `unattributed_policy` and cannot embark.
5. `interaction_failure` and `flake_observation` are durable READ-SIDE
   reconstructions, NOT post-pass engine dispositions. The post-pass evaluator
   runs only after an integrated PASS, so it can neither observe a failed proof
   nor honestly witness two opposite-verdict same-tree observations; a residual
   non-member-attributable `authorizeLand` block there is `unknown_fail_closed`,
   never `interaction_failure`. The HTTP read side
   (`readDurableBatchEvidence`) is the sole producer of both: it projects
   `interaction_failure` from a durable FAILED batch `integration_proof` bound by
   the exact six proof-key components (a checker combined-tree `fail` still lands
   on the existing typed bisect path; MQ-2 starts no ddmin and claims no solved
   culprit), and `flake_observation` from a durable ci-flaky `quarantined_tests`
   row whose `CiFlakyDetectedPayload` proves the toggle
   (`toggledShaCount ≥ 1` + `sampleShas` containing THIS exact proven head) at the
   matching quarantine epoch — never from synthesized per-verdict observations.
   Incomplete gate evidence, a missing/mismatched quarantine epoch, or a head the
   detector never toggled yields no flake state (`unknown_fail_closed` or empty),
   never member failure or infrastructure.
6. Typed infrastructure, product-decision, and untyped/contradictory evidence
   map only to their corresponding closed dispositions.
7. Evaluation/group IDs are deterministic `mqeval_`/`mqgrp_`; member order,
   base/head, proof/policy, and authority reasons are identity-load-bearing.
8. GET list/detail routes are org/project authorized and RLS-scoped. They never
   use process memory, request-local evaluation caches, or a new table:
   - `member_failure`, `transient_infrastructure`, `needs_product_decision`, and
     `unknown_fail_closed` project sole-`EventStore` W0 rows by stable
     evaluation/group IDs.
   - `authorized_subset` projects only when an exact persisted node plus its
     passing proof/binding and all durable authority inputs reconstruct the same
     all-`admit` authorization, or a subsequent SP-4 decision durably proves
     that exact binding. Before such a durable footprint exists, the read side
     is empty/unknown, never green merely because an in-process authorize call
     returned.
   - `interaction_failure` and `flake_observation` project only from complete
     durable batch/gate/quarantine evidence; incomplete evidence becomes
     `unknown_fail_closed`.
     Cross-org detail returns an indistinguishable 404.
9. The existing merge-queue screen renders the seven-way state and ordered
   member outcomes; unavailable/empty state is explicitly unknown, never green.
10. Mutation-sensitive proofs pin:
    - **MQ2-A1** attributed policy emits W0 only for proven members and keeps
      `missionNodeId === "mq-1"`;
    - **MQ2-A2** unattributed multi-member policy is unknown and cannot embark;
    - **MQ2-A3** `authorized_subset` cannot coexist with an excluded member in
      the authorized head;
    - **MQ2-A4** member failure embarks survivors only, never the failed member;
    - **MQ2-A5** evaluation never invokes `land` or CodeHost CAS;
    - **MQ2-A6** HTTP is never green-on-empty and cross-org detail has 404 parity;
    - **MQ2-A7** replayed gate/head/binding freshness cannot authorize;
    - **MQ2-A8** no migration and no event-registry name is added; and
    - **MQ2-A9** every source file is at most 500 lines (or has a documented
      architecture exception).
11. `just affected-typecheck`, focused/affected tests, `just fast-check`,
    `just ci`, and `just smoke` are green at the candidate SHA; source files stay
    at or below 500 lines.

## Anti-cosplay rules

| Consumer kind              | Embark rule                                                | Land rule             |
| -------------------------- | ---------------------------------------------------------- | --------------------- |
| `authorized_subset`        | exact admitted full set may enter sequential fresh re-auth | only sole SP-4 `land` |
| `member_failure`           | proven survivors only; attributed failures withheld        | only sole SP-4 `land` |
| `interaction_failure`      | no embark; typed stop without MQ-3 search                  | none                  |
| `flake_observation`        | no policy embark, blame, or infra cosplay                  | none                  |
| `transient_infrastructure` | existing retry/settle only                                 | none                  |
| `needs_product_decision`   | no embark                                                  | none                  |
| `unknown_fail_closed`      | no embark                                                  | none                  |

- No second enum masquerading as SP-4 `LandDecision`; the seven-way type is a
  consumer evaluation mapped onto the unchanged authority.
- No `authorized_subset` for a head that contains excluded members.
- No caller-supplied policy labels as evidence; findings/review/gate state come
  from durable per-run records and the exact batch proof.
- No in-memory projection, generic event substitute, or claim that unfrozen W3
  events landed.
- No merge-on-evaluate. Every actual member land revalidates freshness and runs
  the sole `MergeAuthorityV2.land` protocol.
