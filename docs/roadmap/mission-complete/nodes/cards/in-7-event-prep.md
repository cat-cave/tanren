# in-7-event-prep — integration authoring event contract prep

**Phase**: Mission-complete event preparation (SP-2 / SP-8)
**Node credit**: **0**
**State**: local authoring candidate; not published, frozen, registered, or emitted
**Base**: `origin/main` @ `8c7d9ff80dfb6f5310c2d2d3a35dd0fc42658897`
**Branch**: `mission/in-7-event-prep`
**Consumes**: SP-2 `AuthoringLifecyclePoint` and the verified
[`in7-event-prep-grok-recon-report.md`](../../../../../.codex/orchestration-prompts/in7-event-prep-grok-recon-report.md)

## Purpose

Prepare the smallest verified input needed to freeze the four IN-7 family
authoring events without installing them. This unit drafts strict payloads,
complete sensitivity and severity mappings, a pure SP-2 lifecycle factory,
best-effort emit semantics, and negative authority pins.

The strings `integration.author.started`, `.attempt`, `.succeeded`, and
`.failed` are **prospective and unfrozen** in this unit. Only a later
SPEC-FREEZE may make them final, and only a later EV-SUB may register, seed, or
migrate them.

## Dependencies and ordering

```text
this PREP (0 credit)
  -> SPEC-FREEZE-W1-A docs freeze (0 credit)
  -> EV-SUB-Wn registry/seed/migration (0 credit)
  -> IN-7 producer + HTTP + UI + apex proof (node credit)
```

This prep depends on the merged SP-2 contract only. It does not depend on IN-1
lifecycle tables, a kernel implementation, or a migration slot.

## Exact exclusive path lease

| Path | Purpose |
| --- | --- |
| `docs/roadmap/mission-complete/nodes/cards/in-7-event-prep.md` | Ownership, dependency, exclusion, and validation authority |
| `docs/roadmap/mission-complete/prep/integration-author-events.md` | Prospective vocabulary, emit rules, sensitivities, severities, and later-wave handoff |
| `services/orchestrator/src/engine/contracts/prep/integrationAuthorEventPayloads.ts` | Unregistered strict Zod payload drafts and metadata |
| `services/orchestrator/src/engine/contracts/prep/integrationAuthorEventFactory.ts` | Pure SP-2 lifecycle mapping and best-effort draft sink helper |
| `services/orchestrator/tests/prep/integrationAuthorEventPrep.test.ts` | Exact schema, mapping, ordering, throw-safety, and non-authority pins |

No wildcard ownership. Amend this card and commit the dependency/path change
before editing any additional path.

## Draft contract

- Every payload is strict and includes `missionNodeId: "in-7"` plus `unitId`.
- `orgId` is required in the factory context and stamped into the event
  envelope, never duplicated in payload.
- `started` carries no unverified Spec fields.
- `attempt` carries the SP-2 attempt number, bounded preview, convergence
  signature, rejection, and closed decision enum. It is absent for an
  un-authored ceiling-breach attempt.
- `succeeded` carries only attempts and can follow only durable persistence plus
  a passed whole-batch compose gate.
- `failed` permits zero attempts. For batch failure/skip it follows retraction;
  for pre-persistence failure it cannot imply a row existed.
- Event delivery is best-effort observability. A sink throw is reported but
  cannot roll back or re-authorize the validated family row.
- Validated, non-retracted family rows remain the sole product authority.
  Draft events are never proof identities, CAS inputs, gate evidence, or land
  signals.

## Hard exclusions

- `events/registry.ts`, any production event schema/rule registration,
  `eventDefaultSeverity.ts`, generated event contracts, or `eventTypesSeed.ts`
- `db/migrations/**`, migration journal/snapshots, or runtime catalog upserts
- `event-vocabulary-waves.md` freeze status or any claim that a name is final
- SP-2 `authoringKernel.ts` or a new kernel implementation
- IN-7 product persistence, producer wiring, HTTP, UI, nav, screens, or apex
- Generic or aliased `fragment.authoring.*` events
- Invented fragment digests, row/event transaction atomicity, or EventStore
  idempotency support
- MergeAuthority, gate-proof, SP-3/CAS, land, or proof-reuse code

## Validation

1. Focused Vitest pins all four strict payloads and bounds, complete leaf-level
   sensitivity, exact severity, factory context/envelope mapping, and template
   namespace isolation.
2. Negative cases prove an event alone creates no validated row, terminal
   success is ineligible before persist+batch pass, batch failure must retract
   before failure emission, and terminal events are XOR per unit.
3. A forced sink throw is swallowed and leaves the caller's validated-row
   authority unchanged.
4. Source-import pins prove the prep modules do not import EventRegistry,
   EventStore, CAS/gate/merge authority, migration, or template event modules.
5. Run `just affected-typecheck`, the focused test, `just affected-test`, format,
   architecture, and diff checks. Root owns full publication gates and smoke.

## Credit and publication

This prep remains zero-credit even when merged. IN-7 remains incomplete until a
later frozen/installed vocabulary is emitted by the real family binding and is
also callable through HTTP, visible in the dashboard, and asserted by live apex
evidence. Do not push or open a PR until the orchestrating root audits the local
candidate.
