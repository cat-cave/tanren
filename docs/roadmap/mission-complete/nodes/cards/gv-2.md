# gv-2 — strict simulated-review forge publication

**Phase**: MVP safety repair (governance Phase 0)  
**State at admission**: defect live on `main` — simulated review posted a forge
`COMMENT` best-effort, discarded publication outcome, then let the internal
Answerer verdict become land-authoritative  
**Purpose**: make simulated-review publication **strict and auditable on the
exact reviewed head**. Real `APPROVE` / `REQUEST_CHANGES`, distinct reviewer
identity, durable forge receipt bound onto the terminal `review.*` event.

## Dependencies

**Hard build dependencies**

- Existing `reviewPolicy: "simulated"` Answerer path (`simulatedReviewer.ts`).
- `GitHubReviewMergeService.submitReview` + managed secret seam
  (`resolveVcsToken` / `credential/github/*`).
- Atomic review terminal (`markReviewTaskDoneWithEvent` / `priorEvents`).
- Existing events `review.approved` / `review.changes_requested` (extended
  payload fields — no new event type, no seed/registry event name).

**Downstream consumers**

- `landSignals.resolveLandTimeSignals` — reads terminal `review.approved` /
  `review.changes_requested` **and** the forge receipt `payload.headSha` as
  `reviewedHeadSha`. Publication failure never emits the event (no land).
  Land authorization (`authorizeAndLand`) requires `reviewedHeadSha ===`
  the exact head being landed when a receipt is present — head advance after
  publication fails closed (re-review), not mere event existence.
- gv-12 (review rules + reviewer identity) builds on this primitive.

## Exclusive ownership

- `docs/roadmap/mission-complete/nodes/cards/gv-2.md`
- `services/orchestrator/src/engine/workflow/reviewMerge/reviewPolling.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/reviewProbeGithub.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/simulatedReviewer.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/simulatedReviewPublication.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/reviewTaskTerminal.ts`
- `services/orchestrator/src/engine/providers/githubReviewMerge.ts`
- `services/orchestrator/src/engine/providers/githubReviewMergeParse.ts`
- `services/orchestrator/src/engine/providers/githubVisibilityProjection.ts`
  (comment-only doc/mirror note)
- `services/orchestrator/src/engine/events/schemas/integrations.ts` (review
  payload fields only — all-or-nothing forge receipt union)
- `services/orchestrator/src/engine/events/sensitivityRules.infra.ts` (review
  payload field tags only — mechanical for schema extension)
- `services/orchestrator/src/engine/merge/landSignals.ts` (`reviewedHeadSha`)
- `services/orchestrator/src/engine/merge/mergeAuthorityGate.ts` (exact-head
  review receipt bind at land)
- `services/orchestrator/src/engine/merge/mergeAuthorityBundleBuild.ts` +
  `mergeDispatchTypes.ts` (thread `reviewedHeadSha`)
- `services/dashboard/src/components/runDetail/ReviewBody.tsx`
- `services/dashboard/src/components/runDetail/model.ts` (forge publication view)
- Focused tests: `simulatedReviewer.test.ts`,
  `simulatedReviewPublication.test.ts`, `githubReviewMergeSubmit.test.ts`,
  `reviewTaskTerminalRouting.test.ts`, `reviewForgePublicationSchema.test.ts`,
  `mergeAuthorityGate.test.ts` (review TOCTOU), `simulatedReviewHeadRebind.test.ts`
  (A→B re-review recovery), `runDetail.model.test.ts`

## Shared-resource leases (not taken)

- Project config / credentials schema (`reviewerGithubCredentialRef` field) —
  GV-1/GV-3. Dual App-writer + static-reviewer uses the **existing**
  `githubCredentialRef` + App install seam; explicit
  `reviewerGithubCredentialRef` is an optional poll-stage input for tests /
  future config wiring.
- `eventTypesSeed` / central registry event **names** — not edited (no new event).
- `mountFeatureRoutes` / nav / `RunDetailBody` / runs index — HTTP uses existing
  run-detail event surface.

## Consumes

- Secret store + App/static dual credential (writer ≠ reviewer login).
- Exact PR head via `readChangeRequestShas` / probe `fetchHeadSha`.
- `PgEventStore` / writer-seam terminal finalize as sole durable observation.

## Produces

### Engine

- Simulated path posts real `APPROVE` or `REQUEST_CHANGES` with `commit_id` =
  exact head SHA, using a distinct reviewer identity.
- Durable receipt `{ forgeReviewId, forgeReviewState, forgeReviewUrl, headSha }`
  is bound onto the same atomic `review.approved` /
  `review.changes_requested` event as the internal verdict.
- Event schema treats forge fields as **all-or-nothing** (union of complete
  receipt vs absent base) — partial tuples fail at the schema boundary.
- Land-time signals expose `reviewedHeadSha` from the receipt; `authorizeAndLand`
  blocks when a present receipt head ≠ the head being landed.
- Missing credential, same-identity, failed, malformed, COMMENT, or
  head-mismatched publication **throws**
  (`SimulatedReviewPublicationError`) — no terminal review.approved, no land.

### Named event proof

- `review.approved` / `review.changes_requested` carry complete forge receipt
  fields when simulated review terminalizes (never a partial tuple).
- Negative: failed/skipped/mismatched publication leaves those events absent.
- Negative: partial forge fields rejected by schema; head-advanced land blocked
  even when `review.approved` exists.

### HTTP

Existing run-detail event list (`GET …/runs/:runId` events) returns the extended
payload under org/project authorization. No new route.

### UI

`ReviewBody` / `ForgePublicationPanel` shows internal phase beside forge id /
state / link / head. Incomplete or missing receipt is **loud** (warn/danger),
never painted as forge success.

## Behavior proof

Positive:

1. Exact-head APPROVE → `review.approved` with complete forge receipt.
2. Exact-head REQUEST_CHANGES → `review.changes_requested` with receipt + feedback.
3. Land with matching `reviewedHeadSha` → authorized (commit-binding satisfied).

Former-bug negative:

4. Failed / head-mismatched / state-mismatched / missing-submit publication
   cannot emit `review.approved` or complete the review task as authorized.
5. `review.approved` present with receipt head A, land head B → land **blocked**
   (does not trust event existence alone).
6. Partial forge tuples rejected at event schema (all-or-nothing).
7. Head advance recovery: review A → head advances to B → re-review B posts a new
   forge receipt that **supersedes** A for land signals (LATEST event); land B
   succeeds only from B's receipt — A never authorizes B. Same-head retry remains
   idempotent (first-wins on the head-bound key).

Auth / forge:

8. Distinct reviewer via managed secret seam (App writer + static reviewer; App
   without static fails closed); reviewer never reuses writer token/identity.
9. Terminal finalize idempotency (strict simulated): first-wins on
   `${runId}:review:${verdict}:${headSha}` — forge review id is **not** in the
   key; same-head retry dedupes; a re-review on a replacement head uses a distinct
   key and lands a new durable receipt (one event stream, no second store).
   Human/auto paths without a forge receipt keep `${runId}:review:${verdict}`.

## Validation

- Focused: `simulatedReviewer.test.ts`, `simulatedReviewPublication.test.ts`,
  `githubReviewMergeSubmit.test.ts`, `reviewTaskTerminalRouting.test.ts`,
  `reviewForgePublicationSchema.test.ts`, `mergeAuthorityGate.test.ts`,
  `simulatedReviewHeadRebind.test.ts`, `runDetail.model.test.ts`.
- `just affected-typecheck origin/main`, `just affected-test origin/main`,
  `just fast-check`, `just ci`.
- Line counts under 500; no migration; no new runtime deps.

## Credential operator note

Strict simulated review requires **two** GitHub identities:

1. **Writer** — App install (preferred) or static token that opens the PR.
2. **Reviewer** — static `credential/github/*` that is a **different** login:
   - Preferred dual seam: App writer + project/org `githubCredentialRef` static
     token as reviewer; or
   - Explicit `reviewerGithubCredentialRef` on the poll-stage input.

Single-credential (same login) fails closed — GitHub rejects self-APPROVE.
