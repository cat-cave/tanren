# mq-1 — typed authority-signal classification (exclusive preparation)

**Phase**: MVP
**State**: exclusive preparation only; not claimable or complete
**Base**: `9f20c3ea9a4d972a2564374abd16c63ed5f6fe87` (includes #928)
**Purpose**: make a deterministic member-local policy failure impossible to
mislabel as infrastructure before the shared merge-queue cutover is leased.

## Exclusive ownership for this preparation

- `docs/roadmap/mission-complete/nodes/cards/mq-1.md`
- `services/orchestrator/src/engine/merge/authoritySignalClassification.ts`
- `services/orchestrator/src/engine/events/schemas/mergeQueueAuthoritySignals.ts`
- `services/orchestrator/src/engine/events/sensitivityRules.mergeQueueAuthoritySignals.ts`
- `services/orchestrator/src/routes/mergeQueue/authoritySignals.ts`
- `services/orchestrator/tests/authoritySignalClassification.test.ts`
- `services/orchestrator/tests/mergeQueueAuthoritySignalsRoutes.test.ts`
- `services/dashboard/src/api/mergeQueueAuthoritySignals.ts`
- `services/dashboard/src/components/mergeQueue/AuthoritySignalPanel.tsx`
- `services/dashboard/tests/mergeQueueAuthoritySignals.render.test.ts`

No file outside this list may be edited under this preparation lease. In
particular, this work does not own a migration, an event registry/seed/default
severity root, a route or dashboard mount, or any merge/coordinator/settlement
path.

## Inputs and produced boundary

The classifier consumes the already-merged spine contracts directly:
`AuthorizeLandInput`, `LandBindingEnvelope`, `LandBindingMember`, `Finding`, and
`AuditPosture`. It derives evaluation, group, member, and event-idempotency
identities from those typed facts. Callers cannot provide an evaluation ID,
group ID, member ID list, repair route, or classification label.

It produces a closed `MergeSignalClassificationV1` evidence union:

- `deterministic_policy`: blocking finding IDs attributed to validated bound
  members; a member-repair disposition is derived from policy evidence;
- `transient_infrastructure`: only an enumerated infrastructure observation,
  always retryable and never member-attributed;
- `needs_product_decision`: an explicit typed decision request and wake key;
- `unknown_fail_closed`: missing, contradictory, untyped, or invalid evidence,
  never infrastructure by default.

The event schemas, sensitivity fragment, read-only HTTP projection, dashboard
client, and panel are prepared beside the classifier. They remain deliberately
unregistered and unmounted until the leases below land. The list HTTP surface
discovers recent signals naturally; it does not require a user-supplied
evaluation query parameter.

## Serialized blockers — do not cross without a new exact-path lease

1. **GV2 first.** GV2 owns the current edits to
   `mergeAuthorityGate.ts` and `mergeDispatchTypes.ts`. MQ1 must rebase after GV2
   and only then classify the structured authorization before reasons are
   flattened.
2. **Migration 0045.** Event-catalog rows for `merge.signal.classified` and
   `merge.member.policy_blocked` belong in migration `0045`, after the ordered
   train `0041` (IN1), `0042` (RV4), `0043` (GV1), and `0044` (GV2). Until 0045
   exists, no production append or live PostgreSQL/RLS event proof is honest.
3. **Shared event roots.** Lease the event schema registry, sensitivity root,
   default severity map, event type seed, migration journal/meta, and schema
   export together with 0045. Registering the schemas then generates
   `contracts/json/events/merge_member_policy_blocked.json` and
   `contracts/json/events/merge_signal_classified.json`; adding those mirrors
   before registry admission would make contract-schema drift fail. There is one
   event store and one catalog path.
4. **Shared consumers.** Lease the route mount, merge-queue route/body, and the
   exact merge settlement paths only after the GV2 rebase. No parallel legacy
   classification or compatibility facade may remain.

## Completion proof still owed after preparation

MQ1 counts only after the shared cutover classifies a planted member-local P1
as `deterministic_policy`, emits both catalog-backed events through the canonical
`EventStore`, excludes the member from every infrastructure-hold path, preserves
typed infrastructure retry behavior, proves cross-org 404/RLS isolation against
real PostgreSQL, exposes the mounted HTTP projection and rendered UI, passes a
negative mutation that maps unknown evidence to infrastructure, and is green on
focused checks, `just fast-check`, `just ci`, `just smoke`, and post-merge main.

This preparation is therefore useful but explicitly insufficient to close the
node.
