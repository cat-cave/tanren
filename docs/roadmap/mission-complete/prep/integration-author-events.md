# Integration author event contracts — PREP only

**Status**: prospective and unfrozen
**Mission consumer**: `in-7`
**Credit**: 0
**Producer status**: none; no production emit is authorized by this document

This prep turns the four SP-2 integration-family lifecycle points into verified
freeze inputs. It does not add an event name to SP-8, the event catalog, a
migration, or a producer. The strings below remain recommendations until a
later SPEC-FREEZE marks exact rows frozen in `event-vocabulary-waves.md`.

## Prospective names and payloads

The envelope owns `orgId` and optional `runId`. Payloads never duplicate
`orgId`, project identity, or credentials. Every payload is a strict object.

| Prospective name               | Exact payload draft                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration.author.started`   | `missionNodeId: z.literal("in-7")`; `unitId: z.string().min(1).max(256)`                                                                                                                                                                          |
| `integration.author.attempt`   | started fields; `attempt: z.number().int().min(1)`; `bodyPreview: z.string().max(500)`; `canonicalSignature: z.string().min(1).max(256)`; `rejection: z.string().max(2_000)`; `decision: z.enum(["continue", "converged", "halted_fixed_point"])` |
| `integration.author.succeeded` | started fields; `attempts: z.number().int().min(1)`                                                                                                                                                                                               |
| `integration.author.failed`    | started fields; `reason: z.string().min(1).max(2_000)`; `attempts: z.number().int().min(0)`                                                                                                                                                       |

`unitId` is exactly the stable identifier handed to the factory by SP-2. No
unverified `Spec` projection, persisted row ID, body, validated artifact,
fragment digest, or secret contract bytes are added. The attempt preview uses
SP-2's `AUTHORING_ATTEMPT_BODY_PREVIEW_MAX`; the signature remains ephemeral
convergence material, never an SP-3 identity.

## Draft metadata

| Name                           | Default severity | Complete sensitivity leaves                                                                        |
| ------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------- |
| `integration.author.started`   | `ok`             | `missionNodeId`, `unitId`                                                                          |
| `integration.author.attempt`   | `info`           | `missionNodeId`, `unitId`, `attempt`, `bodyPreview`, `canonicalSignature`, `rejection`, `decision` |
| `integration.author.succeeded` | `ok`             | `missionNodeId`, `unitId`, `attempts`                                                              |
| `integration.author.failed`    | `fail`           | `missionNodeId`, `unitId`, `reason`, `attempts`                                                    |

Every listed sensitivity is `public`. `bodyPreview` is bounded, non-secret
application source by the existing template doctrine; `canonicalSignature` is
non-authoritative convergence material. A later freeze must revisit these
assumptions if the IN-7 binding admits secret-bearing drafts or diagnostics.

## Factory and emit boundary

The pure draft factory parses `request.context` as a strict
`{ missionNodeId: "in-7", orgId, runId? }` object. It stamps `orgId`/`runId`
into the envelope and `missionNodeId` into the payload, then maps only the
fields present on `AuthoringLifecyclePoint`.

The future IN-7 binding and producer must make `signatures.canonicalize` and
any synthetic failure-signature path yield a non-empty
`canonicalSignature` of at most 256 characters, hashing longer material, and
must bound `rejection` and `reason` diagnostics to 2,000 characters before
factory build. The draft factory validates and throws on overflow; it neither
truncates nor sanitizes producer input.

Firing rules:

1. `started` follows entry to the per-unit authoring loop.
2. `attempt` follows a completed author/validate iteration. A ceiling breach
   for which the authorer was never called emits no attempt.
3. `succeeded` is eligible only after `createValidated` returned, whole-batch
   compose passed, and the row was not retracted.
4. `failed` eligibility is checked at emit time. Before persistence it requires
   no row and a batch state of `not_run`; this is not a post-hoc reconstruction
   rule. On a failed/skipped batch it is eligible only after the persisted row
   was retracted.
5. A complete per-unit trace has exactly one terminal event: `succeeded` XOR
   `failed`.
6. Event append is outside the family persistence transaction and is
   best-effort observability. A sink throw is warned and swallowed; it cannot
   roll back a valid row or turn an invalid row valid.

The validated, post-batch, non-retracted family row remains the sole authority
for compose and downstream selection. Events are not proof identities,
proof-reuse inputs, CAS material, gate evidence, or land signals. The prep
factory intentionally imports no EventStore or authority implementation.

## Collision and non-synonym decisions

| Existing or prospective name                                             | Decision                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `fragment.authoring.*`                                                   | Template F2 only; forbidden for IN-7 emit or live-run substitution |
| `integration.author.*`                                                   | Prospective IN-7 family namespace; not frozen here                 |
| `designFragment.authoring.*`, `verification.author.*`, `policy.author.*` | Sibling family namespaces; never aliases for IN-7                  |
| `integration.requirement.validated`                                      | Frozen IN-2 persisted validate-HTTP fact; unrelated                |
| `integration.requirement.derived`                                        | Deferred compiler fact; unrelated                                  |

## Handoff

The only valid sequence is:

```text
PREP -> SPEC-FREEZE-W1-A -> EV-SUB-Wn -> IN-7 consumer
```

SPEC-FREEZE may cite these modules as verified inputs but must decide the final
names and payload obligations explicitly. EV-SUB then owns the sole Zod
registry, default-severity, sensitivity, codegen seed, and additive catalog
migration path at the then-current free slot (not before the mapped `0045`
owner). Real EventStore/RLS/restart proof belongs to EV-SUB and the consumer.
