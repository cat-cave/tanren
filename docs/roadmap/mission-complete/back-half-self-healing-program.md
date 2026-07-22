# Back-half self-healing cluster — serialized build program

> **Status:** planning doc (authored 2026-07-17). This is the execution plan for the
> general **self-healing cluster** (bh-6/8/10/11/12/13/14), required by the current
> apex-class acceptance fixture — the nodes that make
> the autonomous loop CLOSE: reproduce a planted product bug → fix it → re-verify the
> symptom is gone in **production**, no human in the inner loop. Unlike the parallel
> waves, this cluster is one mutually-dependent chain and runs as a dedicated
> **serialized mini-program**, not scattered lanes. Node IDs/specs are frozen by the
> LEDGER; this doc tracks the _build order_.

## Why serialized (not a wave)

The LEDGER dependency shape is a genuine cycle: bh-6 lists `bh-1/4/8/12/14` (the
walker names everything it drives) while bh-8/10/12 each list bh-6 (every stage needs
the walker's durable job store). It is **not** wave-parallelizable. The cycle is cut by
splitting bh-6 into a **type-leader (bh-6a)** and an **orchestrator (bh-6b)**.

## Substrate already on disk (do NOT re-lay)

- **Tables:** `issue_loops`/`source_findings`/`issue_loop_edges` (0049 bh-1);
  `spec_origins`/`spec_origin_findings` (0051 bh-2); webhook-intake hardening (0052
  bh-3); `symptom_contracts`/`symptom_contract_fragments` (0053 bh-4);
  `verification_assertions`+`symptom_evidence` (0056 bh-5); `source_sync_outbox`
  (0057); `release_instances`/`release_instance_behavior_revisions` with `sha256:`
  `artifact_digest` + state machine (0036 bh-9); `behavior_verification_runs`/
  `behavior_verification_attempts`+`verification_fragments` (0037 — the A1/A3
  runtime-verification substrate bh-10 MUST reuse, not fork).
- **Contracts/code:** `contracts/symptomContract.ts`, `contracts/symptomProbe.ts`
  (`SymptomProbeDriver`), `probes/symptomProbeAdapter.ts` + `probes/httpSymptomProbe.ts`
  (SP·5, already emits `symptom.baseline.started/observed`),
  `repositories/{issueLoops,symptomContracts,symptomEvidence}.ts`,
  `forge/{issueSourceAdapter,githubIssueSourceAdapter,sourceSyncWorker}.ts` (bh-7),
  `contracts/dagWalker.ts` (the durable claim/lease/tick pattern to mirror).
- **Events frozen:** `symptom.contract.{authored,authoring_failed,superseded,validated}`
  (0055); `symptom.baseline.{started,observed}`, `symptom.assertion.recorded`,
  `source.finding.recorded`, `source.sync.{pending,verified,externally_closed_unverified}`
  (0060). Reuse — do not re-declare.

## Cluster pre-flight barrier (front-load ALL serialized work)

One serialized PR before any node, so the chain touches zero barriers:

- **Migration 0069** — `resolution_jobs` (STATEFUL: claim/lease columns mutate),
  `resolution_decisions` (IMMUTABLE, input-snapshot hash), `remediation_attempts`
  (IMMUTABLE); `ALTER behavior_verification_runs ADD stage, resolution_job_id (nullable
FK), classification`. All org_id NOT NULL, `(org_id,id)` PK, deny-by-default RLS
  asserted as `tanren_app` in a `smoke-rls-*` recipe (immutable tables get the
  0053-style BEFORE UPDATE/DELETE trigger).
- **Migration 0070** — event-vocab freeze (Zod registry → regenerated allowlist).
- **`screens.ts`/nav reservation** for bh-14b (the only remaining shared-file barrier).

Next free migration slot after wave-6 (which holds 0064-0068) is **0069**.

### Events to freeze in 0070

`issue_loop.opened`(info) `issue_loop.source_revision_observed`(info)
`issue_loop.reopened`(warn) `issue_loop.verified`(info) `triage.started`(info)
`triage.completed`(info) `spec.origin.linked`(info) `remediation.attempt.started`(info)
`remediation.repair_routed`(warn) `deployment.artifact.bound`(info)
`symptom.verification.started`(info) `symptom.verification.passed`(info)
`symptom.verification.failed`(warn) `symptom.verification.inconclusive`(warn)
`symptom.soak.completed`(info) `resolution.authorized`(info) `resolution.blocked`(warn)
`resolution.needs_attention`(warn) `resolution.waived`(warn)
`source_issue.sync.enqueued`(info) `source_issue.sync.succeeded`(info)
`source_issue.sync.failed`(warn) `source_issue.sync.drifted`(warn)
`resolution.proof.sealed`(info). (`preview.verification.*` deferred — preview/canary
is bh-15+; MVP verifies **production** only.)

## The frozen shared type (bh-6a defines this FIRST — `contracts/resolutionStage.ts`)

```
ResolutionStageKind = "baseline" | "production" | "counterfactual" | "soak"
ResolutionJob    = { id, orgId, projectId, issueLoopId, contractId,
                     releaseInstanceId?, stage, state, leaseOwner, leaseExpiry,
                     idempotencyKey, attempt, priorAttemptId? }
ResolutionStage  = { kind; run(job, ctx): Promise<ResolutionStageResult> }
ResolutionStageResult = { outcome: "passed"|"failed"|"inconclusive";
                          classification: "product_failure"|"infra_failure"|"stale_contract"|"inconclusive";
                          proofGrade: "active_causal"|"active_plus_soak"|"observational"|"attested";
                          verificationRunId; assertionIds[]; evidenceRefs[] }
```

## Serial execution order

0. **Cluster pre-flight barrier** — 0069 + 0070 + screens.ts/nav reservation. Merge, freeze base SHA.
1. **bh-6a** — Resolution contract type + `resolution_jobs` store + walker skeleton (startup+periodic scan, `FOR UPDATE SKIP LOCKED` claim, idempotency keys, replay-safe; NO stage logic). Include the shared `behavior_verification_runs` stage-write helper here so 8∥10 don't collide. ~600-800 lines. Deps bh-1/4.
2. **bh-8** — Baseline reproduction stage (run locked contract vs current live release; product-failure = baseline, infra-failure = inconclusive/`awaiting_reproduction`, never silently dismissed). ~500 lines. Deps bh-6a/4/5.
3. **bh-10** — Production symptom verification (bind exact artifact digest, re-run SAME contract vs production; the false-green catch). Split **10a** production replay / **10b** counterfactual+soak if >1000. Deps bh-6a/8/9/4/5; REUSE A1/A3 ports.
4. **bh-6b** — ResolutionDagWalker orchestration loop (wire stages into the durable tick; drive loop-state transitions). ~800 lines. Deps bh-6a/8/10.
5. **bh-11** — ResolutionAuthority (fail-closed; the ONLY component that may declare resolution / enqueue source closure; consumes an immutable evidence snapshot; NO code-land capability). ~600 lines. Deps bh-10. SP·4 sibling of MergeAuthority.
6. **bh-12** — Source-sync outbox + readback (transactional close/reopen via `IssueSourceAdapter`; `verified_source_sync_pending` until provider receipt AND readback agree → `verified_closed`). ~600 lines. Deps bh-11/7.
7. **bh-13** — P0 repair routing (on `resolution.blocked`, create a P0 successor repair spec linked via `spec_origins` role=`repair`; original spec never reopened). MVP = **deterministic routing only**. ~600 lines. Deps bh-11/1/2.
8. **bh-14a** — proof seal (`tanren-resolution-proof.v1.json` hash-chain) + `GET .../proof`, then **bh-14b** — Self-Healing dashboard surface (funnel + loop-detail causal graph + separate gate/merged/deploy/demo/symptom/source truth badges). Deps bh-1..13. (>1000 → the a/b split; bh-14b carries the screens.ts/nav edit reserved in step 0.)

## 2-lane sub-waves (behind a shared barrier)

- **Sub-wave A (behind bh-6a):** bh-8 ∥ bh-10 — disjoint files (baseline probe vs production/deploy binding).
- **Sub-wave B (behind bh-11):** bh-12 ∥ bh-13 — disjoint (forge/outbox vs workflow/spec-origins), both triggered only by a bh-11 decision.
- bh-6a, bh-6b, bh-11, bh-14 are strictly serial.

## Definition of done (per node) — the planted-scenario negative control

Each node proves via named event(s) + a callable HTTP surface + dashboard visibility.
The decisive one is **bh-10/bh-11**: on the first _cosmetic_ fix, `symptom.verification.failed`
fires and `resolution.blocked` is recorded **while** reachability (401/403) and the generic
demo stay green — the truth badges are never collapsed. On the real fix,
`symptom.verification.passed` + `resolution.authorized` with the `sha256:` artifact digest
in `deployment.artifact.bound`. There is **no public `mark-verified` endpoint**.

## The one deferred sub-decision (LLM-intent, → bh-15+)

**bh-13's failure-signature fixed-point + hypothesis/model mutation.** Deciding "same
symptom recurred → mutate the approach" vs "new info → route another literal repair" is
an LLM-intent judgment, filed under full-tier failure-aware model routing. **MVP bh-13
ships deterministic-only** (one P0 successor per distinct failure signature;
identical-signature recurrence → `needs_attention`, hard stop — no arbitrary attempt cap).

## Closing this cluster is necessary but not sufficient for the v97 normal-flow fixture run

The current apex example's dependency path is **{this cluster} ∪ {rv runtime-probe
execution tail} ∪ {in-\* deploy/provision + A3-live-observe}**. These are general
capabilities, not an apex-specific path:

1. **rv tail** — bh-8/bh-10 reuse the A1/A3 ports; the rv nodes that actually execute a
   DOM/visual probe against a live surface and materialize `verification_assertions`
   must land, or the symptom oracle has nothing real to execute.
2. **in-\* deploy/provision** — bh-10's `deployment.artifact.bound` needs a real deployed
   product surface (a live URL/channel, e.g. the fixture's "Slack at 100 clicks") that
   the integrations capability-DAG provisioner/binding-materializer/A3-live-trigger
   nodes produce.

Closing bh-6/8/10/11/12/13/14 makes the self-healing _decision loop_ provable
end-to-end; a normal-flow run of the planted-bug fixture additionally requires the rv
probe-execution and in-\* deploy nodes green so there is a live artifact to reproduce
against and re-verify on.
