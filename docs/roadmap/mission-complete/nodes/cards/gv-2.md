# gv-2 — strict simulated-review forge publication

**Phase**: governance Phase 0 (safety repairs) · `sm`  
**Base**: `origin/main` / `4e02f707096b26d8390cbc7fbb5248b495b7c397` (post #964 IN-7 PREP; EV-SUB-W0 + GV-1 landed)  
**Branch**: `mission/gv-2-final`  
**Worktree**: `.codex/worktrees/gv-2-final`

**Purpose**: close the F1 live defect where simulated review posts a forge
`COMMENT` best-effort, discards publication outcome, and lets the internal
Answerer verdict become land-authoritative. Make simulated-review publication
**strict and auditable on the exact reviewed head**: real `APPROVE` /
`REQUEST_CHANGES`, distinct reviewer identity, durable first-wins intent via
sole EventStore, PG advisory single-flight, forge receipt bound onto the
terminal `review.*` event, sequential land TOCTOU on `reviewedHeadSha`.

## Dependencies

**Hard product prerequisite**

- **GV-1** landed (#963) — auditPosture CAS guard; not re-opened here.

**Spine / shared contracts (read-only, already on main)**

- EV-SUB-W0 catalog row + Zod + sensitivity for `review.simulated_intent`
  (`0042_event_vocabulary_w0.sql`, `eventVocabularyW0.ts`, seed/registry) —
  **consume only; no migration / seed / registry ownership**.
- Existing terminal events `review.approved` / `review.changes_requested`.
- Sole `MergeAuthorityV2` (SP-4) + sole `EventStore` / `PgEventStore`.
- `GitHubReviewMergeService` + managed secret seam (`resolveVcsToken`).
- Atomic review terminal (`markReviewTaskDoneWithEvent` / `priorEvents`).
- Existing run-detail HTTP event GET (org/project auth + redaction).

**Not a hard prerequisite**

- **MQ-2** multi-member evaluate — soft file lease only on `landSignals` /
  sequential land writers. No DAG edge `mq-2 → gv-2`.

## Exclusive ownership

| Path                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- |
| `docs/roadmap/mission-complete/nodes/cards/gv-2.md`                                                         |
| `services/orchestrator/src/engine/workflow/reviewMerge/reviewPolling.ts`                                    |
| `services/orchestrator/src/engine/workflow/reviewMerge/simulatedReviewer.ts`                                |
| `services/orchestrator/src/engine/workflow/reviewMerge/reviewTaskTerminal.ts`                               |
| `services/orchestrator/src/engine/workflow/reviewMerge/reviewProbeGithub.ts`                                |
| `services/orchestrator/src/engine/workflow/reviewMerge/simulatedReviewPublication.ts`                       |
| `services/orchestrator/src/engine/workflow/reviewMerge/simulatedReviewIntent.ts`                            |
| `services/orchestrator/src/engine/workflow/reviewMerge/simulatedReviewPublishFence.ts`                      |
| `services/orchestrator/src/engine/workflow/reviewMerge/simulatedReviewStage.ts`                             |
| `services/orchestrator/src/engine/workflow/reviewMerge/index.ts` (re-export only)                           |
| `services/orchestrator/src/engine/providers/githubReviewMerge.ts`                                           |
| `services/orchestrator/src/engine/providers/githubReviewMergeParse.ts`                                      |
| `services/orchestrator/src/engine/events/schemas/reviewForgeReceipt.ts` (receipt-Zod line-cap extract only) |
| `services/dashboard/src/components/runDetail/ReviewBody.tsx`                                                |
| `services/dashboard/src/components/runDetail/reviewMergeState.ts`                                           |

### Exact focused proof ownership

| Path                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------ |
| `services/orchestrator/tests/githubReviewMergeSubmit.test.ts`                                                            |
| `services/orchestrator/tests/mergeAuthorityGate.test.ts`                                                                 |
| `services/orchestrator/tests/reviewTaskTerminalRouting.test.ts`                                                          |
| `services/orchestrator/tests/simulatedReviewer.test.ts`                                                                  |
| `services/orchestrator/tests/reviewForgePublicationSchema.test.ts`                                                       |
| `services/orchestrator/tests/simulatedReviewForgeConverge.test.ts`                                                       |
| `services/orchestrator/tests/simulatedReviewHeadRebind.test.ts`                                                          |
| `services/orchestrator/tests/simulatedReviewIntentFence.pg.integration.test.ts`                                          |
| `services/orchestrator/tests/simulatedReviewIntentFence.test.ts`                                                         |
| `services/orchestrator/tests/simulatedReviewPublication.test.ts`                                                         |
| `services/orchestrator/tests/simulatedReviewPublishFence.test.ts`                                                        |
| `services/orchestrator/tests/gv2StrictForgeExactHead.test.ts` (named mutation gate)                                      |
| `services/orchestrator/tests/simulatedReviewReviewerRotation.test.ts` (pinned credential / retry mutation gate)          |
| `services/orchestrator/tests/runDetailReviewReceipt.contract.test.ts` (real GET/redaction proof)                         |
| `services/orchestrator/tests/runFailureClassifierTypedArms.test.ts` (safe public classification)                         |
| `services/orchestrator/tests/runFinalizeAuthority.test.ts` (retriable vs permanent disposition)                          |
| `services/dashboard/tests/reviewMergeState.test.ts`                                                                      |
| `services/orchestrator/tests/simulatedReviewIntentProductionComposition.test.ts` (append-only fallback must fail closed) |
| `services/orchestrator/tests/simulatedReviewIntentSchema.test.ts` (line-cap split; frozen W0 poison controls)            |
| `services/orchestrator/tests/planeSplitP3RemoteWrites.integration.test.ts` (direct/HTTP prior-event seam parity)         |

## Thin shared (serialize, not exclusive thrash)

| Path                                                  | Wire                                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `engine/merge/landSignals.ts`                         | Add `reviewedHeadSha` from durable forge receipt and export the shared exact receipt/head guard MQ-2 must consume; sole EventStore read                                              |
| `engine/merge/mergeAuthorityGate.ts`                  | Outer exact-head review TOCTOU only; no second authority                                                                                                                             |
| `engine/merge/mergeAuthorityBundleBuild.ts`           | **A2 non-exclusive carry only:** thread `reviewedHeadSha` exactly like on-main `gatedHeadSha`; IN-1's `resolveVcsToken({ orgId })` hunk is disjoint and must survive the later union |
| `engine/workflow/reviewMerge/mergeDispatchTypes.ts`   | Thread receipt head field only if needed                                                                                                                                             |
| `engine/worker/runFailureClassifier.ts`               | Classify strict-publication errors to a fixed public-safe merge failure; never expose provider text                                                                                  |
| `engine/workflow/runFinalizeAuthority.ts`             | Consume the error's explicit retriable bit: contention/head drift re-drive, permanent forge/identity failure halts                                                                   |
| `events/schemas/integrations.ts`                      | Event-specific all-or-nothing forge receipt variants                                                                                                                                 |
| `events/sensitivityRules*.ts`                         | Mechanical public tags for new receipt leaves only                                                                                                                                   |
| Dashboard `model.ts`                                  | Line-cap extract only → `reviewMergeState.ts`; no nav/screens                                                                                                                        |
| `engine/eventStore.ts`                                | Extend the sole EventStore with its existing atomic prior-event capability; no second store                                                                                          |
| `engine/worker/directRunStateWriter.ts`               | Delegate durable intent first-wins to the sole `PgEventStore.appendPriorIfAbsent`                                                                                                    |
| `engine/worker/httpRunStateWriter.ts`                 | Carry the same keyed prior append through the control-plane writer seam                                                                                                              |
| `routes/internal/runStateWrites.ts`                   | mTLS-only, org-scoped keyed-prior endpoint using the sole `PgEventStore` implementation                                                                                              |
| `contracts/json/events/review_approved.json`          | Generated mirror of the event-specific approved receipt union                                                                                                                        |
| `contracts/json/events/review_changes_requested.json` | Generated mirror of the event-specific changes-requested receipt union                                                                                                               |

`reviewPolling.ts` is an IN-1 convergence union: retain
`resolveVcsToken({ orgId: context.orgId, ... })` while GV-2 replaces the
publication flow. Neither shared intersection is an exclusive GV-2 claim.

## Hard exclusions (do not edit)

| Path / resource                                              | Owner                |
| ------------------------------------------------------------ | -------------------- |
| `db/migrations/**`, `_journal.json`, any `0043+`             | IN-1 / RV-4 / train  |
| `eventTypesSeed.ts`, W0 registry/sensitivity/JSON for intent | EV-SUB-W0 **landed** |
| `event-vocabulary-waves.md` freeze prose                     | IN-7 SPEC-FREEZE     |
| `multiMemberAuthority*`, batch coordinator embark evaluators | **MQ-2** exclusive   |
| Integrations routes/UI, `0043_*`                             | **IN-1**             |
| Behavior coverage / future `0044_*`                          | **RV-4**             |
| Frozen SP-4 `AuthorizeLandInput` shape rewrite               | forbidden            |
| `screens.ts` / `mountFeatureRoutes` / nav / `main.ts`        | avoid                |
| #856 dirty BFF salvage                                       | salvage only         |

## Produces

### Engine

1. **Strict forge events** — `APPROVE` / `REQUEST_CHANGES` only; never COMMENT
   cosplay. Distinct reviewer login (provider-proved ≠ PR writer).
2. **One coherent snapshot** `{baseSha, headSha, diff}` + pre-POST head
   revalidation (no split `fetchDiff` ∥ `fetchHeadSha`).
3. **Mandatory provider receipt** — `forgeReviewId`, `forgeReviewState`,
   `forgeReviewUrl`, `headSha`, `reviewerLogin` (all required for simulated).
4. **First-wins `review.simulated_intent`** via sole EventStore **before** forge
   I/O; frozen W0 payload; never land authority.
5. **PG advisory single-flight** on PR/head/reviewer (state-independent key);
   response-loss list→reconcile; no JS production fallback store; fence-busy
   wired to retriable disposition for workflow redrive.
6. **Atomic terminal** — task complete + event-specific all-or-nothing forge
   receipt (literal matching state).
7. **Sequential land bind** — `landSignals.reviewedHeadSha` + outer
   `mergeAuthorityGate` TOCTOU; head A receipt cannot land head B.
8. **Multi-member contract** — without editing MQ-2 exclusive modules: export a
   shared receipt/head assert for future consume; simulated-review policy fails
   closed on sequential path without receipt; no multi-member bypass claimed.

### HTTP / UI

- No new mutation endpoint. Run-detail event GET carries receipt through real
  redaction. UI multi-state: intent-pending / publishing / published /
  stale-head / failed / non-simulated no-receipt — never green from event name
  alone.

### Named adversarial gate

`GV2-STRICT-FORGE-EXACT-HEAD` covering: COMMENT regression, split snapshot,
missing/partial receipt, same identity, response-loss no duplicate POST,
opposing state fence, head A→B, cross-org RLS, intent ≠ approval.

## Credit

**+1 only** after full engine + HTTP + UI + adversarial proofs + green
`just fast-check` / `just ci` (smoke/PR serialized by root). Zero migration
ownership. Migration-slot framing (0044) is **obsolete** — W0 already owns intent.

## Negative controls

1. COMMENT / best-effort publication cannot authorize land.
2. Intent alone never appears in landSignals as approval.
3. Partial / missing / COMMENT / same-identity / head-mismatched receipt → no
   terminal `review.approved`.
4. `review.approved` head A + land head B → blocked.
5. Response-loss reclaims; no second POST when durable review exists.
6. Fence busy → retriable, zero unfenced POST.

## Validation

- Focused unit/PG/route/render + named gate tests.
- Production composition: append-only/non-durable stores fail before Answerer or
  forge I/O; both direct and HTTP writers preserve the caller idempotency key and
  concurrent workers read back one durable first-wins intent.
- Retry mutation pins: PG fence connect, lock-query, and post-success unlock
  failures remain explicitly retriable and route through run-finalize re-drive.
- UI provenance negatives: unrelated task/run failures cannot become forge
  publication failures, and bare human `review.requested` stays neutral.
- Regenerate and check the two terminal-review JSON contract mirrors; run the
  architecture check after the test split, finalizer reduction, and reconcile
  decomposition (no cap suppression).
- `just affected-typecheck` / `affected-test`; `just fast-check`; `just ci`.
- Files ≤ 500 lines; no smoke/push/PR from this author.

## Evidence note

`node/gv-2-simulated-review-publication@ef2893f7` is **read-only design input**.
Clean redrive from exact main — no rebase/merge/cherry-pick of that history.
