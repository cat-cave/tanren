# atomic-recovery-park — fail-closed, indivisible recovery parking

**Phase**: mergequeue Phase 0 prerequisite
**Purpose**: provide one direct/remote write authority that parks an exact active
merge-queue owner at `needs_attention`, emits the park and dequeue events in order,
and dequeues it in the same org-scoped transaction. A failed or unprovable park
returns typed `parking_failed`, never grants a dequeue receipt, and carries a delay
from the canonical bounded merge-retry schedule. Only an exact active owner paired
with an ineligible spec proves `retained`; invalid, missing, inactive, write, and
transport failures report `unknown`. A lost COMMIT acknowledgement is resolved by
idempotent readback of the exact settled queue receipt.

## Dependencies

**Hard build dependencies**

- The merged run-state writer spine: `RunStateWriter`, `DirectRunStateWriter`,
  `HttpRunStateWriter`, the internal mTLS lifecycle routes, and `PgEventStore`.
- Existing `specs` / `runs` / `merge_queue` RLS ownership and the existing
  `dag.spec.needs_attention` / `merge.dequeued` event contracts.

**Downstream consumer**

- The later clean replacement for PR #928 (`conflict-dequeue-redrive`) must consume
  `RunStateWriter & RecoveryParkWriter`. It owns recovery enqueue/run/task evidence,
  resolver and coordinator wiring, base-shift/percolation behavior, and UI. It may
  not recreate a sequential park-then-dequeue path.

## Exclusive ownership

- `docs/roadmap/mission-complete/nodes/cards/atomic-recovery-park.md`
- `services/orchestrator/src/engine/contracts/runStateAtomicSeam.ts`
- `services/orchestrator/src/engine/contracts/runStateWriter.ts` (type re-export only)
- `services/orchestrator/src/engine/worker/recoveryParkAtomic.ts`
- `services/orchestrator/src/engine/worker/directRunStateWriter.ts`
- `services/orchestrator/src/engine/worker/httpRunStateWriter.ts`
- `services/orchestrator/src/routes/internal/runStateAtomicWrites.ts`
- `services/orchestrator/tests/recoveryParkAtomic.test.ts`
- `services/orchestrator/tests/recoveryParkEndpoint.test.ts`
- `services/orchestrator/tests/recoveryParkAtomic.rls.integration.test.ts`

No migration, generated schema, generic recovery API/UI, coordinator, resolver,
planner, insight, base-shift/percolation, fixture, nav, `screens.ts`, or `main.ts`
change belongs to this unit.

## Consumes

- The exact queue ownership tuple: `orgId + projectId + queueId + runId + specId`.
- `runWithOrgScope` and the existing direct-org RLS policies.
- `PgEventStore.append` as the only event append authority.
- The existing merge retry schedule for the typed redrive delay.

## Produces

- Interface-segregated `RecoveryParkWriter`, implemented by both run-state writers.
- `parkRecoveryAndDequeue(input)` with outcomes:
  - `parked`: the live spec park, ordered events, and queue dequeue committed together;
    a retry after a lost response resolves from the same durable queue row even when
    the spec has since progressed through a legal attention-resolution transition.
  - `parking_failed`: ownership, lifecycle, write, or transport could not be proven;
    reason and disposition are a coupled union (impossible pairs are rejected), and
    `retryAfterMs` must be one of the canonical merge-retry schedule values.
- `POST /internal/park-recovery-and-dequeue` over the existing mTLS-only internal app.

## Negative controls

- Missing, mismatched, or wrong-org queue ownership never mutates a spec, emits an
  event, or dequeues an entry.
- The ownership read locks the exact queue, run, spec, and project tuple before any
  mutation; independently valid but cross-linked foreign keys are not ownership.
- A non-active queue or spec not eligible for recovery parking fails closed.
- Failure after the spec UPDATE rolls back the status, both events, and dequeue.
- Direct and HTTP paths share request validation (including empty-message rejection)
  and return the same typed outcome; the server validates again after mTLS auth.
- Fresh success orders `dag.spec.needs_attention` before `merge.dequeued` exactly.

## Validation

- Focused unit tests pin SQL ordering, rollback, retention, response decoding, auth,
  and transport failure.
- Gated real-Postgres tests pin direct/HTTP parity, enforced RLS/wrong-org behavior,
  atomic rollback, idempotent response-loss redrive, and durable event order.
- Affected format, lint, typecheck, architecture, and test checks only; no full gate
  or smoke in this prerequisite worktree.
