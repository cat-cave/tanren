# mq-1 — v96 regression lock and typed authority-signal classification

**Phase**: MVP  
**State at admission**: spine-backed claim; not complete  
**Purpose**: prove that a deterministic member-local policy failure is never
relabelled as infrastructure and never becomes a whole-batch infrastructure hold.

## Dependencies

- `SP-4` on `main`: `MergeAuthorityV2`, `Finding`, `AuditPosture`, and the
  fail-closed land-input vocabulary.
- The #928 clean replacement must land before mq-1 claims or edits
  `batchCoordinator.ts` or `batchCoordinatorSettle.ts`. Its atomic recovery-park
  prerequisite is not an mq-1 API dependency, so this branch is based directly on
  `origin/main` rather than stacked on that prerequisite.

The safe-subset solver, member isolation, exact node materialization, and one-CAS
land belong to `mq-2..5` and `mq-11`; mq-1 does not claim them. It produces the
closed signal taxonomy those nodes must consume.

## Exclusive ownership

- `docs/roadmap/mission-complete/nodes/cards/mq-1.md`
- `services/orchestrator/src/engine/merge/authoritySignalClassification.ts`
- `services/orchestrator/src/engine/events/schemas/mergeQueueAuthoritySignals.ts`
- `services/orchestrator/src/engine/events/sensitivityRules.mergeQueueAuthoritySignals.ts`
- `contracts/json/events/merge_member_policy_blocked.json`
- `contracts/json/events/merge_signal_classified.json`
- `services/orchestrator/src/routes/mergeQueue/authoritySignals.ts`
- `services/orchestrator/tests/authoritySignalClassification.test.ts`
- `services/orchestrator/tests/mergeQueueAuthoritySignalsRoutes.test.ts`
- `services/orchestrator/tests/mergeQueueAuthoritySignals.rls.integration.test.ts`
- `services/dashboard/src/api/mergeQueueAuthoritySignals.ts`
- `services/dashboard/src/components/mergeQueue/AuthoritySignalPanel.tsx`
- `services/dashboard/tests/mergeQueueAuthoritySignals.render.test.ts`

No spine contract, proof store, land capability, migration slot, route mount,
event registry, or dashboard parent is exclusively owned by this node.

## Serialized integration leases

Acquire an exact-path lease only after rebasing to the current `origin/main` and
release it before independent verification:

- `services/orchestrator/src/engine/events/registry.ts`
- `services/orchestrator/src/engine/events/schemas/mergeQueue.ts` (event-fragment re-export only)
- `services/orchestrator/src/engine/events/sensitivityRules.ts`
- `services/orchestrator/src/engine/notifications/eventDefaultSeverity.ts`
- `db/src/eventTypesSeed.ts` only when the event-codegen lease is granted
- migration `0042` for event-catalog inserts only, queued behind in-1's exclusive
  ownership of `0041` plus the journal/meta/schema export
- `services/orchestrator/src/routes/experiments/mount.ts` (report-family mount only)
- `services/dashboard/src/routes/mergeQueue/index.tsx`
- `services/dashboard/src/components/mergeQueue/MergeQueueBody.tsx`
- `services/orchestrator/src/engine/merge/mergeAuthorityGate.ts`
- `services/orchestrator/src/engine/workflow/reviewMerge/mergeLandPaths.ts`
- after #928 replacement: `services/orchestrator/src/engine/merge/batchCoordinator.ts`
  and `services/orchestrator/src/engine/merge/batchCoordinatorSettle.ts`

## Produces

`MergeSignalClassificationV1`, a closed discriminated union:

- `deterministic_policy`: attributed member IDs and finding IDs, a stable reason
  code and signal version, and a typed repair route;
- `transient_infrastructure`: a typed provider/runner source, retryability, and a
  wake key, with no blamed member;
- `needs_product_decision`: an explicit review/HITL decision and wake key;
- `unknown_fail_closed`: missing, contradictory, or untyped evidence, never
  infrastructure by default.

Classification is evidence only. It cannot authorize or execute a land and it
does not create a second event or proof store.

## Clean replacement

- No message-regex classification and no catch-all `Error -> infrastructure` map.
- A `blocked` MergeAuthority decision is not presumed transient. Its structured
  input and typed source are classified before queue settlement.
- One member-local policy finding cannot enter `recoverableDriveHold`,
  `BatchInfraHoldCeiling`, or `escalateInfraHoldToWriter` for the whole batch.
- No facade, compatibility branch, feature flag, or dual event path remains.

## Durable projection, HTTP, and UI

The classifier appends only through `EventStore.append`:

- `merge.signal.classified`
- `merge.member.policy_blocked`

The event row/envelope carries organization/project/run identity. Its payload
carries `missionNodeId: "mq-1"`, evaluation and group identity, member and finding
IDs, reason code, signal version, classification, retryability, wake key, and
source event identity where applicable. Finding prose and raw provider evidence
are not copied into the event.

`GET /orgs/:orgId/projects/:projectId/merge-queue/evaluations/:evaluationId/signals`
requires organization membership plus project authorization and reads the event
projection under `runWithOrgScope`. A cross-organization evaluation returns 404
without metadata leakage.

`AuthoritySignalPanel` on `/merge-queue` shows policy, infrastructure, product
decision, and unknown states with member attribution and source event ID. Unknown
or absent data never renders as green or transient.

## Behavior proof

Positive control: an unfixable P1 finding attributed only to member C classifies
`deterministic_policy`; the event, HTTP response, and rendered panel name C and the
finding ID; no infrastructure classification or batch-hold request occurs.

Negative controls:

- a typed provider timeout is `transient_infrastructure`, blames no member, and
  emits no policy-block event;
- an untyped thrown error is `unknown_fail_closed`;
- an unattributed P1 fails closed rather than guessing C;
- a second organization cannot read the evaluation;
- mutating the unknown-error arm to infrastructure makes the focused proof fail.

## Required checks

During authoring: `just affected-typecheck`, `just affected-test`, and the focused
orchestrator/dashboard tests. Before handoff after the serialized cutover and rebase:
`just fast-check`, `just ci`, and `just smoke`, plus an independent exact-head audit.

The node counts complete only after the named-event proof, HTTP authorization/RLS
proof, rendered UI proof, negative mutation proof, full gates, merge SHA, and green
post-merge `main` proof exist. Owned modules alone do not close mq-1.
