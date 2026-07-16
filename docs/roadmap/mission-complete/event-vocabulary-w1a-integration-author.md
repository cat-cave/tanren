# Event vocabulary W1-A — IN-7 integration author freeze

**Status**: W1-A frozen (`SPEC-FREEZE-W1-A`)
**Authority index**: [`event-vocabulary-waves.md`](./event-vocabulary-waves.md)
**Ownership card**: [`nodes/cards/spec-freeze-w1-a.md`](./nodes/cards/spec-freeze-w1-a.md)
**Base**: `origin/main` @ `4e02f707096b26d8390cbc7fbb5248b495b7c397`
**Verified source**: merged PREP @
`a4ea6eb040359d78dabc1b81e22e89978cb012fe`
**Node credit**: freeze = 0 · EV-SUB-W1-A = 0 · IN-7 consumer only
after emit + HTTP + UI + live apex proof

This linked document is the durable row authority for exactly four W1-A
events. It extends the single freeze protocol in `event-vocabulary-waves.md`
only because the index began at 384 lines. It is not a registry, catalog,
producer, migration, or second freeze protocol.

## 1. Exact scope and provenance

| Final name                     | Severity | Mission node | Status   |
| ------------------------------ | -------- | ------------ | -------- |
| `integration.author.started`   | `ok`     | `in-7`       | `frozen` |
| `integration.author.attempt`   | `info`   | `in-7`       | `frozen` |
| `integration.author.succeeded` | `ok`     | `in-7`       | `frozen` |
| `integration.author.failed`    | `fail`   | `in-7`       | `frozen` |

No fifth name enters W1-A. The sole producer mission node is `in-7`; there is
no co-producer.

| Accepted PREP input                 | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `integrationAuthorEventPayloads.ts` | `24b263a859fd20c0f3e442630aad3d5819355d6eee2080ef9d2dd91dca991951` |
| `integrationAuthorEventFactory.ts`  | `6794e8aff4950a817c7829dd3845de51c2e690dbd89ab942f27cc9b597687091` |
| `integration-author-events.md`      | `18c7556ec0744586145ffd4139ba5fd13534346277e1ca50276bc80bbd3df5e7` |

The accepted PREP five-path manifest digest is
`567e34152d34b54df59f38e37001d7b7f872522102ca56d808a3d527f3010ecf`.
The payload and factory modules were independently audited at those exact
hashes. A semantic change requires a new GO audit, not an implicit freeze edit.

## 2. Envelope, strictness, and versioning

- Factory context is strict:
  `{ missionNodeId: z.literal("in-7"), orgId: z.string().min(1).max(256), runId: z.string().min(1).max(256).optional() }`.
- `orgId` is required on the `PgEventStore` row. Optional `runId`, when
  present, is non-empty and at most 256 characters. The event envelope, never
  the payload, owns both.
- Optional event-row `projectId`, `taskId`, and `specId` are not required by
  W1-A and must not be duplicated into payloads.
- Every payload below is a flat `.strict()` object. The listed sensitivity
  leaves are the complete field set; every leaf is `public`.
- Payloads have no `version` field. Stability is the final event name plus its
  exact strict field set. A breaking change requires a new freeze with new
  names, or an explicit later protocol, never a silent reshape.

## 3. Frozen rows

### 3.1 `integration.author.started`

**Semantic fact:** the IN-7 per-unit authoring loop was entered. This is
identity-only observability and does not project the opaque `Spec`.

| Sensitivity leaf | Exact zodHint                | Tag      |
| ---------------- | ---------------------------- | -------- |
| `missionNodeId`  | `z.literal("in-7")`          | `public` |
| `unitId`         | `z.string().min(1).max(256)` | `public` |

**Apex correlation:** `missionNodeId === "in-7"` and `unitId` identify the
entered lifecycle unit. The event alone neither creates nor proves a validated
row.

### 3.2 `integration.author.attempt`

**Semantic fact:** one completed author/validate iteration's bounded
trajectory observability. A ceiling breach for which the authorer was never
called emits no attempt.

| Sensitivity leaf     | Exact zodHint                                             | Tag      |
| -------------------- | --------------------------------------------------------- | -------- |
| `missionNodeId`      | `z.literal("in-7")`                                       | `public` |
| `unitId`             | `z.string().min(1).max(256)`                              | `public` |
| `attempt`            | `z.number().int().min(1)`                                 | `public` |
| `bodyPreview`        | `z.string().max(500)`                                     | `public` |
| `canonicalSignature` | `z.string().min(1).max(256)`                              | `public` |
| `rejection`          | `z.string().max(2_000)`; empty allowed                    | `public` |
| `decision`           | `z.enum(["continue", "converged", "halted_fixed_point"])` | `public` |

`bodyPreview` is constrained non-secret application source for operator
trajectory, the same data class as live `fragment.authoring.attempt`, and is
bounded by `AUTHORING_ATTEMPT_BODY_PREVIEW_MAX`. `canonicalSignature` is
ephemeral convergence material, never an SP-3 identity, proof, or digest.

**Apex correlation:** `missionNodeId`, `unitId`, `attempt`, bounded preview,
signature, rejection, and closed decision must match the completed SP-2
lifecycle point.

### 3.3 `integration.author.succeeded`

**Semantic fact:** `createValidated` returned for the unit, whole-batch compose
passed, and the validated row was not retracted. The event does not make a
fragment usable; the durable, validated, non-retracted row remains authority.

| Sensitivity leaf | Exact zodHint                | Tag      |
| ---------------- | ---------------------------- | -------- |
| `missionNodeId`  | `z.literal("in-7")`          | `public` |
| `unitId`         | `z.string().min(1).max(256)` | `public` |
| `attempts`       | `z.number().int().min(1)`    | `public` |

**Emit-time eligibility:**
`persisted && batchVerdict === "passed" && !retracted`.

**Apex correlation:** identity and attempt count match the SP-2 terminal point,
and the authoritative family row is present, validated, and non-retracted.

### 3.4 `integration.author.failed`

**Semantic fact:** terminal non-success for the unit. Zero attempts is valid
for failure before the first completed iteration.

| Sensitivity leaf | Exact zodHint                  | Tag      |
| ---------------- | ------------------------------ | -------- |
| `missionNodeId`  | `z.literal("in-7")`            | `public` |
| `unitId`         | `z.string().min(1).max(256)`   | `public` |
| `reason`         | `z.string().min(1).max(2_000)` | `public` |
| `attempts`       | `z.number().int().min(0)`      | `public` |

Eligibility is checked at emit time, not reconstructed later:

- pre-persist:
  `!persisted && batchVerdict === "not_run" && !retracted`;
- post-batch failure or skip:
  `persisted && retracted && (batchVerdict === "failed" || batchVerdict === "skipped")`.

**Apex correlation:** identity, bounded reason, and attempt count match the
terminal lifecycle point. Pre-persist failure correlates to row absence;
post-batch failure correlates to deletion/retraction before event emission.

## 4. Producer-signature binding

The family factory maps only fields already carried by SP-2
`AuthoringLifecyclePoint`. Context stamps the mission and envelope identity.

| Lifecycle point | Frozen event                   | Exact binding                                                                              |
| --------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| `started`       | `integration.author.started`   | `unitId` from lifecycle; `missionNodeId` from strict context                               |
| `attempt`       | `integration.author.attempt`   | `attempt`, `bodyPreview`, `canonicalSignature`, `rejection`, and `decision` from lifecycle |
| `succeeded`     | `integration.author.succeeded` | `attempts` from lifecycle; never project `validated`                                       |
| `failed`        | `integration.author.failed`    | `reason` and `attempts` from lifecycle                                                     |

Forbidden projections are `spec`, `draft`, `validated`, `persistedId`, Spec
`kind`/`label`, fragment or CAS digests, credentials, secret contract bytes,
and any invented product field.

The future IN-7 binding/producer must satisfy these duties before factory
build:

1. `signatures.canonicalize` and any synthetic failure-signature path produce
   a non-empty `canonicalSignature` of at most 256 characters; hash longer
   material. The factory validates and throws; it does not truncate.
2. Bound `rejection` and `reason` diagnostics to 2,000 characters. The factory
   does not sanitize or truncate them.
3. SP-2 truncates preview to 500 characters; the payload independently rejects
   a longer value.

## 5. Emit, ordering, and authority

| Invariant            | Frozen obligation                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| Ordering             | `started` on loop entry → zero or more completed `attempt` events → exactly one terminal                  |
| Terminal cardinality | Exactly one of `succeeded` XOR `failed` per unit in a complete plan                                       |
| Delivery             | Best-effort observability; a sink throw is warned and swallowed (`warn_and_continue`)                     |
| Transaction          | Event append is outside the family persistence transaction                                                |
| Product authority    | Validated, non-retracted family row only                                                                  |
| Events are not       | Row substitutes, proof identities, proof-reuse/CAS inputs, gate evidence, MergeAuthority, or land signals |

Successful appends become durable org-scoped EventStore rows only after
EV-SUB-W1-A installs strict Zod schemas and matching `event_types` FK rows. A
sink or warning failure is an observability gap, not a product-state rollback
or authorization change.

There is no automatic EventStore idempotency obligation for these names.
`PriorEventInput`, `(run_id, idempotency_key)`, and free-form domain keys are
not part of W1-A; optional future application dedupe requires a separate
contract.

## 6. Collision and compatibility decisions

| Existing or deferred name                                                | W1-A decision                                                                           |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `fragment.authoring.*`                                                   | Template F2 only; forbidden synonym, alias, producer event, or apex substitute for IN-7 |
| `integration.author.*`                                                   | Final W1-A family namespace for IN-7; exactly the four rows in §1                       |
| `designFragment.authoring.*`, `verification.author.*`, `policy.author.*` | Sibling families; never aliases                                                         |
| `integration.requirement.validated`                                      | W0 IN-2 validate-HTTP fact; unrelated and unchanged                                     |
| `integration.requirement.derived`                                        | Deferred compiler fact; unrelated and not promoted by W1-A                              |
| `integration.requirement.superseded`                                     | Deferred lifecycle fact; not promoted by W1-A                                           |
| Plane-A `integration.provisioned`                                        | Existing provision fact; unrelated to authoring                                         |

The four final names have zero `blocked_collision`. W0 rows and meanings are
immutable. Dual catalogs, runtime `event_types` upserts, hand-seeded rows, and
generic substitutes remain forbidden.

## 7. Replay, negative controls, and apex proof

The replay contract is the frozen type string plus the strict payload shape.
Successful rows correlate by `missionNodeId === "in-7"`, `unitId`, and the
listed lifecycle fields. Terminal evidence must agree with authoritative row
presence or absence; it never replaces that check. Real Postgres append/FK/RLS
and restart read-back proofs belong to EV-SUB-W1-A and the IN-7 consumer.

EV-SUB and consumer conformance must preserve these negative controls:

1. An event alone creates no validated family row.
2. A sink or warning throw leaves row authority unchanged and does not escape.
3. Batch failure/skip retracts the persisted row before `failed`; retraction
   makes `succeeded` ineligible.
4. Each complete unit trace has exactly one terminal.
5. The IN-7 binding never emits `fragment.authoring.*`.
6. These events cannot authorize MergeAuthority, proof reuse, CAS, a gate, or
   land.

## 8. PREP-to-freeze round trip

| Verified PREP surface                      | Durable freeze match                            |
| ------------------------------------------ | ----------------------------------------------- |
| Four prospective strings                   | Four final strings in §1; no fifth name         |
| Every strict key, bound, and decision enum | Field-for-field tables in §3                    |
| Severity map `ok` / `info` / `ok` / `fail` | Exact §1 severity column                        |
| Complete sensitivity draft leaves          | Exact set-equal §3 leaf tables; all `public`    |
| Factory lifecycle-to-type switch           | Exact four-arm mapping in §4                    |
| Terminal eligibility helper                | Equivalent emit-time boolean rules in §3.3–§3.4 |
| Throw-safe emit-boundary helper            | Equivalent ordering/authority obligations in §5 |

The round trip freezes PREP obligations, not the PREP modules as production
schemas. EV-SUB-W1-A must implement the one production registry path without
inventing a field, enum, regex, sensitivity leaf, severity, firing gate, or
alias.

## 9. Zero-credit handoff

```text
SPEC-FREEZE-W1-A (this docs-only freeze)
  -> EV-SUB-W1-A (strict Zod + severity + sensitivity + codegen + catalog)
  -> IN-7 consumer (producer + HTTP + UI + live apex)
```

This freeze takes no migration slot. EV-SUB-W1-A chooses the then-current free
additive catalog slot only after mapped 0043–0045 owners land (at least
0046-class on the current map). It owns real EventStore/RLS/restart proofs.

Still deferred: `integration.requirement.derived`/`superseded`, A3 validation
and stimulus/effect chains, delivery/grant/resource facts, and every event name
beyond the four in §1. Freeze and EV-SUB each earn zero node credit; only the
later callable, visible, apex-proven IN-7 consumer may earn the node.
