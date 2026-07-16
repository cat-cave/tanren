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
  payload fields) **plus** a new non-terminal intent event
  `review.simulated_intent` (first-wins Answerer fence).

**Migration serialization blocker (honest)**

- PR #931 migration `0040_event_vocabulary.sql` is **immutable spine** and stays
  byte-identical to `origin/main` (no in-place edit). Runtime `eventTypesSeed.ts`
  - Zod/registry/JSON/severity/sensitivity carry the app catalog row, but are
    **not** an upgrade mechanism for existing DBs.
- The DB catalog row for `review.simulated_intent` requires a **new post-0040
  migration**. **IN-1 currently owns unmerged 0041**, so this branch **cannot
  become merge-ready** until IN-1 lands and GV-2 restacks to add the next
  serialized migration (**expected 0042**). Do not invent startup DDL or a
  second vocabulary seeder. Opt-in real-PG tests may seed the row in isolated
  setup and must label upgrade proof as blocked until that migration exists.

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
- `services/orchestrator/src/engine/workflow/reviewMerge/simulatedReviewIntent.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/simulatedReviewPublishFence.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/simulatedReviewStage.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/reviewTaskTerminal.ts`
- `services/orchestrator/src/engine/providers/githubReviewMerge.ts`
- `services/orchestrator/src/engine/providers/githubReviewMergeParse.ts`
- `services/orchestrator/src/engine/providers/githubVisibilityProjection.ts`
  (comment-only doc/mirror note)
- `services/orchestrator/src/engine/events/schemas/integrations.ts` (review
  payload fields only — all-or-nothing forge receipt union)
- `services/orchestrator/src/engine/events/schemas/reviewSimulatedIntent.ts`
  (Zod cross-field cohere for the new intent event)
- `services/orchestrator/src/engine/events/sensitivityRules.infra.ts` (review
  payload field tags only — mechanical for schema extension)
- `services/orchestrator/src/engine/events/sensitivityRules.review.ts`
- `services/orchestrator/src/engine/merge/landSignals.ts` (`reviewedHeadSha`)
- `services/orchestrator/src/engine/merge/mergeAuthorityGate.ts` (exact-head
  review receipt bind at land)
- `services/orchestrator/src/engine/merge/mergeAuthorityBundleBuild.ts` +
  `mergeDispatchTypes.ts` (thread `reviewedHeadSha`)
- `services/dashboard/src/components/runDetail/ReviewBody.tsx`
- `services/dashboard/src/components/runDetail/model.ts` (cost/trajectory/
  reasoning/preview view-model only — review/merge reducer extracted)
- `services/dashboard/src/components/runDetail/reviewMergeState.ts`
  (review/merge event reducer + gv-2 forge publication tri-state; extracted
  from `model.ts` so each file stays under the 500-line architecture cap)
- Focused tests: `simulatedReviewer.test.ts`,
  `simulatedReviewPublication.test.ts`, `simulatedReviewIntentFence.test.ts`,
  `simulatedReviewIntentFence.pg.integration.test.ts` (opt-in real PG; pre-
  migration seed), `simulatedReviewPublishFence.test.ts`,
  `githubReviewMergeSubmit.test.ts`, `reviewTaskTerminalRouting.test.ts`,
  `reviewForgePublicationSchema.test.ts`, `mergeAuthorityGate.test.ts` (review
  TOCTOU), `simulatedReviewHeadRebind.test.ts` (A→B re-review recovery),
  `runDetail.model.test.ts` (cost/trajectory/reasoning view-model),
  `reviewMergeState.test.ts` (review/merge reducer + forge publication view,
  moved out of `runDetail.model.test.ts` to respect the 500-line cap)

## Shared-resource leases (not taken)

- Project config / credentials schema (`reviewerGithubCredentialRef` field) —
  GV-1/GV-3. Dual App-writer + static-reviewer uses the **existing**
  `githubCredentialRef` + App install seam; explicit
  `reviewerGithubCredentialRef` is an optional poll-stage input for tests /
  future config wiring.
- Migration serial number **0041** — **owned by IN-1** (unmerged). GV-2 must not
  create 0041; after IN-1 merges, GV-2 adds the next number for the intent
  catalog row (expected 0042). App-side `eventTypesSeed` / registry already list
  `review.simulated_intent` as codegen/catalog data.
- `mountFeatureRoutes` / nav / `RunDetailBody` / runs index — HTTP uses existing
  run-detail event surface.

## Consumes

- Secret store + App/static dual credential (writer ≠ reviewer login).
- Exact PR head via `readChangeRequestShas` / probe `fetchHeadSha`.
- `PgEventStore` / writer-seam terminal finalize as sole durable observation.

## Produces

### Engine

- **New intent event** `review.simulated_intent`: first-wins durable Answerer
  decision on exact run/head **before** any forge I/O (lookup → Answerer only
  if absent → `appendPriorIfAbsent` + readback winner). Never land authority.
- Simulated path posts real `APPROVE` or `REQUEST_CHANGES` with `commit_id` =
  exact head SHA, using a distinct reviewer identity, under a **bounded**
  PostgreSQL `pg_try_advisory_lock` publication fence (busy → retriable
  fail-loud, zero provider I/O, job redrive re-lists/reclaims). No JS
  production fallback; unlock failure destroys the pool client.
- Durable receipt `{ forgeReviewId, forgeReviewState, forgeReviewUrl, headSha }`
  is bound onto the same atomic `review.approved` /
  `review.changes_requested` event as the internal verdict.
- Event schema treats forge fields as **all-or-nothing** (union of complete
  receipt vs absent base) — partial tuples fail at the schema boundary.
  Intent payload Zod cross-field refinement requires state/event/marker/body
  cohere; poison fails loud on lookup.
- Land-time signals expose `reviewedHeadSha` from the receipt; `authorizeAndLand`
  blocks when a present receipt head ≠ the head being landed.
- Missing credential, same-identity, failed, malformed, COMMENT, or
  head-mismatched publication **throws**
  (`SimulatedReviewPublicationError`) — no terminal review.approved, no land.

### Named event proof

- **New:** `review.simulated_intent` carries non-secret publication identity
  (head, state, event, body, message, reviewerLogin, marker). App registry +
  seed list it; **DB upgrade row blocked on post-IN-1 migration**.
- `review.approved` / `review.changes_requested` carry complete forge receipt
  fields when simulated review terminalizes (never a partial tuple).
- Negative: failed/skipped/mismatched publication leaves those events absent.
- Negative: partial forge fields rejected by schema; head-advanced land blocked
  even when `review.approved` exists.
- Negative: intent never consumed by landSignals / MergeAuthority / UI as
  approval.

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
  `simulatedReviewIntentFence.test.ts`, `simulatedReviewPublishFence.test.ts`,
  `githubReviewMergeSubmit.test.ts`, `reviewTaskTerminalRouting.test.ts`,
  `reviewForgePublicationSchema.test.ts`, `mergeAuthorityGate.test.ts`,
  `simulatedReviewHeadRebind.test.ts`, `runDetail.model.test.ts`.
- Real-PG (opt-in `TANREN_RLS_DB_TEST=1`):  
  `simulatedReviewIntentFence.pg.integration.test.ts` — dual-client try-lock +
  eventStore first-wins; seeds catalog row; **not** upgrade proof.
- `just affected-typecheck origin/main`, `just affected-test origin/main`,
  `just fast-check`, `just ci`.
- Line counts under 500; **no migration on this branch** (IN-1 serial blocker);
  no new runtime deps.
- **Merge-ready only after:** IN-1 lands → restack → add serialized migration
  for `review.simulated_intent` (expected 0042) → fresh audit.

## Credential operator note

Strict simulated review requires **two** GitHub identities:

1. **Writer** — App install (preferred) or static token that opens the PR.
2. **Reviewer** — static `credential/github/*` that is a **different** login:
   - Preferred dual seam: App writer + project/org `githubCredentialRef` static
     token as reviewer; or
   - Explicit `reviewerGithubCredentialRef` on the poll-stage input.

Single-credential (same login) fails closed — GitHub rejects self-APPROVE.
