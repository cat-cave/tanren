# Event vocabulary waves — freeze authority

<!-- cspell:ignore mqeval mqgrp mqwake -->

**Status**: W0 frozen (SPEC-FREEZE-W0) · W1-A frozen (SPEC-FREEZE-W1-A)
**Bases**: W0 `1f1eda2ed678f8ea7f12eef4a8362e22dbd39fee` · W1-A
`4e02f707096b26d8390cbc7fbb5248b495b7c397`
**Latest landed migration on main**: `0042_event_vocabulary_w0.sql`
**Cards**: [`nodes/cards/ev-sub-w0.md`](./nodes/cards/ev-sub-w0.md) ·
[`nodes/cards/spec-freeze-w1-a.md`](./nodes/cards/spec-freeze-w1-a.md)
**Node credit**: freeze = 0 · EV-SUB = 0 · consumer emit+apex = node credit

**Mission entrypoint:** this authority, its linked W1-A detail, and the linked
ownership cards are the complete W0 and W1-A named-event handoff; source refs
below are provenance only.

This file is the durable single roadmap authority for **named-event freeze
waves**. Bucket specs and prep cards are inputs; once a row is `frozen` here,
implementers must use the exact name + payload obligations — not invent
generics, not silently rename, not hand-seed outside the SP-8 path.

---

## 1. Freeze protocol

### 1.1 Units

| Unit               | What                                                                                                                                                | Credit                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **SPEC-FREEZE-Wn** | Docs freeze: exact names, severity, minimal strict payload fields, sensitivity, apex correlation, collision resolution                              | **0**                           |
| **EV-SUB-Wn**      | Thin substrate: Zod in sole `EventRegistry` path + `eventDefaultSeverity` + sensitivity + `codegen:events` + one additive `INSERT INTO event_types` | **0**                           |
| **Consumer emit**  | Production `PgEventStore` append of the frozen name + HTTP/UI + apex correlation                                                                    | **node** when principle 8 holds |

### 1.2 Status vocabulary (per row)

| Status              | Meaning                                                                                |
| ------------------- | -------------------------------------------------------------------------------------- |
| `frozen`            | May enter the matching EV-SUB wave; name string is final for that wave                 |
| `deferred`          | Acknowledged alternative or later-wave fact; **not** a synonym; **not** in this EV-SUB |
| `blocked_collision` | Two claims compete; **no** EV-SUB until freeze picks a winner                          |

Only `frozen` names may land in EV-SUB-Wn. W0 has **zero** `blocked_collision`
rows.

### 1.3 Payload / envelope rules

1. **Envelope owns tenancy.** `PgEventStore` requires `orgId`; `projectId`,
   `runId`, `taskId`, `specId` are optional columns. **Do not** duplicate
   org/project identity inside the strict payload unless a verified node proof
   genuinely needs the field for correlation (none of the W0 prep schemas do).
2. **Secret-free.** Payloads carry digests, opaque ids, closed enums, and
   non-secret publication identity. Never tokens, credentials, secret values,
   raw source contents, or provider secret blobs.
3. **Identity-bound.** Every payload must prevent a same-name event from
   proving the wrong command/entity/generation (digests, analysis ids,
   evaluation ids, head SHAs, mission node ids as required by the fact).
4. **Strict object.** EV-SUB implements `.strict()` Zod schemas matching the
   field list (union discriminants allowed when prep schemas already use them).
5. **Sensitivity taxonomy** (repo `Sensitivity` enum only):
   `public` | `redacted` | `secret`.
6. **Severity taxonomy** (repo `Severity`): `ok` | `info` | `warn` | `fail`.
7. **Alternations** expand in freeze (separate names or one name + enum field) —
   never left for implementers to invent.

### 1.4 SP-8 authority (do not dual-path)

```text
Zod EventRegistry → eventDefaultSeverity → eventTypeVocabulary()
        → codegen:events → eventTypesSeed.ts → migration INSERT event_types
PgEventStore.append validates Zod + FK to event_types
```

Forbidden: runtime upsert of `event_types`; hand-edit seed without codegen;
second catalog; generic substitute events for apex proof.

---

## 2. Migration / substrate boundary (post-freeze map)

| Slot            | Owner                  | Purpose                                                                                                              |
| --------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **0041**        | **CAS-SUB**            | `config_revision` + sole `ProjectStore` CAS (not event catalog)                                                      |
| **0042**        | **EV-SUB-W0**          | Additive `event_types` INSERTs for **frozen W0 names only** + registry/severity/sensitivity/codegen mirror           |
| **0043**        | **IN-1**               | `integration_lifecycle` clean-replacement (no vocabulary ownership)                                                  |
| **0044**        | **RV-4**               | Coverage composite-FK / non-event schema only; **strip** catalog ownership of `behavior.coverage.selection_analyzed` |
| **(no mig)**    | **GV-1 / GV-2 / MQ-1** | Product + emit restacks; catalog pre-seeded by EV-SUB-W0                                                             |
| **0045**        | **GV-3**               | Policy/gate land-identity CHECKs / purge (not event catalog)                                                         |
| **≥0046-class** | **EV-SUB-W1-A**        | Install only the four W1-A rows after mapped 0043–0045 land; choose the actual then-free slot at authoring           |

**Product order note:** GV-1 → GV-2 → MQ-1 may still serialize where they share
MergeAuthority / governance writers; that is **not** a 1:1 catalog-migration
chain. **IN-2 emit** after EV-SUB-W0 (not after IN-1). SPEC-FREEZE and EV-SUB
earn **zero** node credit.

---

## 3. Deferred / non-synonymous alternatives (not W0 collisions)

| Name / family                                                                                                                                                   | Relation                                                                                                                                       | Status                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `integration.requirement.derived`                                                                                                                               | Future **compiler** fact (requirement derived from behaviors/specs). **Not** a synonym of `validated` (HTTP validate-success proof).           | `deferred` (later integrations wave) |
| `integration.requirement.superseded`                                                                                                                            | Lifecycle successor of a derived requirement.                                                                                                  | `deferred`                           |
| `review.simulated.started`                                                                                                                                      | Later **execution** fact when simulated publication I/O begins. Distinct from durable intent `review.simulated_intent`.                        | `deferred`                           |
| `review.simulated.verdict`                                                                                                                                      | Later **execution** terminal simulated verdict fact. Distinct from intent and from forge-bound `review.approved` / `review.changes_requested`. | `deferred`                           |
| Remaining bucket apex chains (runtime behavior.\*, integrations lifecycle beyond W1-A, mq group/subset, back-half, governance F1–F5 remainder, designSystem.\*) | Incomplete / under-specified for one dump                                                                                                      | `deferred` (W1+)                     |

These are **explicitly not** `blocked_collision` against W0 winners.

---

## 4. W0 frozen rows

### 4.1 `integration.requirement.validated`

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **name**            | `integration.requirement.validated`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **wave**            | W0                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **status**          | `frozen`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **missionNodes**    | `in-2`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **defaultSeverity** | `info`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **semantic fact**   | A caller-supplied `IntegrationRequirementV1` passed strict semantic validation on the **persisting validate-HTTP path**, its canonical bytes were stored by CAS, and that artifact was successfully reread before append. Append only after the reread confirms the stored artifact identity. This is not compiler derivation. Never append for `persist:false`, overview/dry-run/check-only, failed CAS put, failed or mismatched CAS reread, or parse-only validation. |
| **payload fields**  | See the complete strict schema below.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **apexCorrelation** | `missionNodeId === "in-2"` ∧ `requirementDigest` ∧ all `artifact.*` fields match the persisting validate response and the reread CAS artifact.                                                                                                                                                                                                                                                                                                                           |
| **sources**         | Card `mission/in-2-integration-requirement-contracts:nodes/cards/in-2.md`; `integrationRequirement.ts` and validate route `routes/integrationContracts/index.ts` @ `b5edc57318245d778a52e3f63cb8e4a579a7da2b`; IN-2 convergence report R1–R3; fanout audit §3.4–§6.2.                                                                                                                                                                                                    |

**Payload (top-level and `artifact` objects are strict; envelope owns `orgId`)**

| sensitivity leaf     | exact zodHint                                                         | tag      |
| -------------------- | --------------------------------------------------------------------- | -------- |
| `missionNodeId`      | `z.literal("in-2")`                                                   | `public` |
| `requirementDigest`  | `z.string().regex(/^sha256:[0-9a-f]{64}$/u)`                          | `public` |
| `artifact.digest`    | `z.string().regex(/^sha256:[0-9a-f]{64}$/u)`                          | `public` |
| `artifact.byteSize`  | `z.number().int().nonnegative()`                                      | `public` |
| `artifact.mediaType` | `z.literal("application/vnd.tanren.integration-requirement.v1+json")` | `public` |
| `capability`         | `z.string().min(1).max(128)`                                          | `public` |
| `plane`              | `z.enum(["control","product"])`                                       | `public` |
| `direction`          | `z.enum(["inbound","outbound","bidirectional"])`                      | `public` |
| `criticality`        | `z.enum(["merge_required","release_required","best_effort"])`         | `public` |

Those nine rows are the complete sensitivity-leaf set; every tag is `public`.
The event cannot claim `artifact.*` unless the persisting path completed both
CAS put and reread before `PgEventStore.append`.

**Collision resolution:** Winner = `validated` for validate-HTTP.
`integration.requirement.derived` remains a separate future fact (`deferred`).

---

### 4.2 `behavior.coverage.selection_analyzed`

| Field               | Value                                                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **name**            | `behavior.coverage.selection_analyzed`                                                                                                                                                                                                             |
| **wave**            | W0                                                                                                                                                                                                                                                 |
| **status**          | `frozen`                                                                                                                                                                                                                                           |
| **missionNodes**    | `rv-4`                                                                                                                                                                                                                                             |
| **defaultSeverity** | `info`                                                                                                                                                                                                                                             |
| **semantic fact**   | Durable, replayable affected-selection proof: which active behavior revisions were selected (or explicitly excluded) for a set of changed targets under fail-closed coverage edges. Org/project live on the event row.                             |
| **apexCorrelation** | `analysisId` + selected/excluded `behaviorRevisionId` sets + `changedTargets` match the selection run under test                                                                                                                                   |
| **sources**         | Card `redrive/rv-4-post943:docs/roadmap/mission-complete/nodes/cards/rv-4.md`; Zod `BehaviorCoverageSelectionAnalyzedPayload`, `affectedSelection.ts`, and `sensitivityRules.runtimeVerification.ts` @ `c601cae77419a1ef16f805f1a5fe7b708c394b6b`. |

**Payload (root and every nested object/reason arm are strict)**

- `version`: `z.literal("v1")`.
- `analysisId`: `z.string().min(1)`.
- `mode`: `z.enum(["targeted","expanded_unknown","no_active_behaviors"])`.
- `changedTargets`: `z.array(AffectedTarget).max(500)`.
- `unknownTargets`: `z.array(AffectedTarget).max(500)`.
- `AffectedTarget`: `{ kind: z.enum(["spec","source","component","integration","design"]), targetRef: z.string().min(1).max(2_000) }`.
- `selected`: array of strict `{ behaviorRevisionId: z.string().min(1), reasons: z.array(SelectionReason).min(1) }` objects.
- `excluded`: array of strict `{ behaviorRevisionId: z.string().min(1), reason: z.literal("no_reachable_changed_target"), inspectedEdgeIds: z.array(z.string().min(1)).min(1) }` objects.

`SelectionReason` is this complete discriminated union:

| `kind`                  | Required fields besides `kind`                                                 |
| ----------------------- | ------------------------------------------------------------------------------ |
| `direct_edge`           | `edgeId: z.string().min(1)`; `target: AffectedTarget`                          |
| `transitive_dependency` | `edgeId: z.string().min(1)`; `dependencyBehaviorRevisionId: z.string().min(1)` |
| `unknown_target`        | `target: AffectedTarget`                                                       |
| `uncovered_behavior`    | none                                                                           |
| `dangling_dependency`   | `edgeId: z.string().min(1)`; `targetRef: z.string().min(1)`                    |
| `no_changed_targets`    | none                                                                           |

The complete sensitivity path set below is copied from
`sensitivityRules.runtimeVerification.ts` @
`c601cae77419a1ef16f805f1a5fe7b708c394b6b`; every path is `public`:

```text
version
analysisId
mode
changedTargets
changedTargets[].kind
changedTargets[].targetRef
unknownTargets
unknownTargets[].kind
unknownTargets[].targetRef
selected
selected[].behaviorRevisionId
selected[].reasons
selected[].reasons[].kind
selected[].reasons[].edgeId
selected[].reasons[].target.kind
selected[].reasons[].target.targetRef
selected[].reasons[].dependencyBehaviorRevisionId
selected[].reasons[].targetRef
excluded
excluded[].behaviorRevisionId
excluded[].reason
excluded[].inspectedEdgeIds
excluded[].inspectedEdgeIds[]
```

---

### 4.3 `governance.audit_posture.updated`

| Field               | Value                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **name**            | `governance.audit_posture.updated`                                                                                                                                                                                                                                        |
| **wave**            | W0                                                                                                                                                                                                                                                                        |
| **status**          | `frozen`                                                                                                                                                                                                                                                                  |
| **missionNodes**    | `gv-1`                                                                                                                                                                                                                                                                    |
| **defaultSeverity** | `info`                                                                                                                                                                                                                                                                    |
| **semantic fact**   | An actual audit-posture **transition** committed: org-admin governance PUT successfully CAS-wrote a new `auditPosture` and appended this fact in the **same transaction**. No-op posture PUT emits nothing. Payload is non-secret mutation evidence (who + before/after). |
| **apexCorrelation** | `actorUserId` + `previous`/`current` postures match the CAS transition; event absent on reserved PATCH / stale CAS / authz failure                                                                                                                                        |
| **sources**         | Card `node/gv-1-audit-posture-write-guard:docs/roadmap/mission-complete/nodes/cards/gv-1.md`; Zod `GovernanceAuditPostureUpdatedPayload`, `AuditPostureConfig`, and `sensitivityRules.governance.ts` @ `b8099d6a85f806954192f925a21385fd9fba9922`.                        |

**Payload (strict)**

| path                             | zodHint                                  | sensitivity |
| -------------------------------- | ---------------------------------------- | ----------- |
| `actorUserId`                    | `z.string().min(1)`                      | `public`    |
| `previous.blockReviewAt`         | `z.enum(["P0","P1","P2","P3"])`          | `public`    |
| `previous.p2p3Handling`          | `z.enum(["fix-if-idle","route-to-dag"])` | `public`    |
| `previous.autonomousRemediation` | `z.boolean()`                            | `public`    |
| `current.blockReviewAt`          | `z.enum(["P0","P1","P2","P3"])`          | `public`    |
| `current.p2p3Handling`           | `z.enum(["fix-if-idle","route-to-dag"])` | `public`    |
| `current.autonomousRemediation`  | `z.boolean()`                            | `public`    |

---

### 4.4 `review.simulated_intent`

| Field               | Value                                                                                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **name**            | `review.simulated_intent`                                                                                                                                                                                                                                                                                |
| **wave**            | W0                                                                                                                                                                                                                                                                                                       |
| **status**          | `frozen`                                                                                                                                                                                                                                                                                                 |
| **missionNodes**    | `gv-2`                                                                                                                                                                                                                                                                                                   |
| **defaultSeverity** | `info`                                                                                                                                                                                                                                                                                                   |
| **semantic fact**   | Durable **simulated-publication intent** (first-wins Answerer fence) on exact head **before** forge I/O. Never land authority. Distinct from later execution facts `review.simulated.started` / `review.simulated.verdict` and from terminal forge-bound `review.approved` / `review.changes_requested`. |
| **apexCorrelation** | `headSha` (40 hex) + coherent `state`/`event`/`marker`/`body` for the intended verdict; land signals must **not** treat this event as approval                                                                                                                                                           |
| **sources**         | Card `node/gv-2-simulated-review-publication:docs/roadmap/mission-complete/nodes/cards/gv-2.md`; Zod `ReviewSimulatedIntentPayload` and `sensitivityRules.review.ts` @ `ef2893f774acd9b778f888f9e2e807150d71f040`.                                                                                       |

**Payload (strict + cross-field cohere)**

| path            | zodHint                                                    | sensitivity |
| --------------- | ---------------------------------------------------------- | ----------- |
| `headSha`       | `z.string().regex(/^[0-9a-fA-F]{40}$/u)`                   | `public`    |
| `state`         | `z.enum(["approved","changes_requested"])`                 | `public`    |
| `event`         | `z.enum(["APPROVE","REQUEST_CHANGES"])` must match `state` | `public`    |
| `body`          | `z.string().min(1)` containing exact marker line           | `public`    |
| `message`       | `z.string()`                                               | `public`    |
| `reviewerLogin` | `z.string().min(1)`                                        | `public`    |
| `marker`        | exact `tanren-simulated-review:v1:${state}`                | `public`    |

---

### 4.5 `merge.signal.classified`

| Field               | Value                                                                                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **name**            | `merge.signal.classified`                                                                                                                                                                                                                                                             |
| **wave**            | W0                                                                                                                                                                                                                                                                                    |
| **status**          | `frozen`                                                                                                                                                                                                                                                                              |
| **missionNodes**    | `mq-1`                                                                                                                                                                                                                                                                                |
| **defaultSeverity** | `info`                                                                                                                                                                                                                                                                                |
| **semantic fact**   | Durable, prose-free authority-signal classification for one evaluation: closed union of `deterministic_policy` \| `transient_infrastructure` \| `needs_product_decision` \| `unknown_fail_closed`, with invariants that make infrastructure/member-blame mislabeling unrepresentable. |
| **apexCorrelation** | `missionNodeId === "mq-1"` ∧ `evaluationId` ∧ `groupId` ∧ `classification` (+ member/finding sets when policy)                                                                                                                                                                        |
| **sources**         | Card `redrive/mq1-post928-prep:docs/roadmap/mission-complete/nodes/cards/mq-1.md`; Zod `MergeSignalClassifiedPayload` and `sensitivityRules.mergeQueueAuthoritySignals.ts` @ `336ce4fbee9caf3b02aa9aab37ce77c74a5276f3`.                                                              |

**Payload (strict discriminated union)**

Every arm has this exact common identity:

| path            | exact zodHint                                                                 |
| --------------- | ----------------------------------------------------------------------------- |
| `missionNodeId` | `z.literal("mq-1")`                                                           |
| `evaluationId`  | `z.string().regex(/^mqeval_[0-9a-f]{64}$/u)`                                  |
| `groupId`       | `z.string().regex(/^mqgrp_[0-9a-f]{64}$/u)`                                   |
| `signalVersion` | `z.literal("merge_signal.v1")`                                                |
| `memberIds`     | `z.array(z.string().min(1))`; values must equal `[...new Set(values)].sort()` |
| `findingIds`    | `z.array(z.string().min(1))`; values must equal `[...new Set(values)].sort()` |

The four arms are closed as follows. “Any canonical length” means the common
sorted/unique array may be empty or non-empty; no extra length refinement is
permitted.

| `classification`           | exact `reasonCode` set                                                                                                              | `retryability`  | `wakeKey`                                    | `disposition`            | `memberIds`   | `findingIds`         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------- | ------------------------ | ------------- | -------------------- |
| `deterministic_policy`     | `audit_policy`                                                                                                                      | `non_retryable` | `null`                                       | `member_repair`          | non-empty     | non-empty            |
| `transient_infrastructure` | `provider_timeout`, `provider_rate_limit`, `runner_unavailable`, `runner_transport`, `code_host_unavailable`, `gate_infrastructure` | `retryable`     | `z.string().regex(/^mqwake_[0-9a-f]{64}$/u)` | `retry_when_ready`       | exactly empty | exactly empty        |
| `needs_product_decision`   | `review_changes_requested`, `hitl_pending`                                                                                          | `non_retryable` | `z.string().regex(/^mqwake_[0-9a-f]{64}$/u)` | `await_product_decision` | exactly empty | exactly empty        |
| `unknown_fail_closed`      | `untyped_evidence`, `unattributed_policy`, `contradictory_evidence`, `invalid_binding`, `unclassified_authority_block`              | `unknown`       | `null`                                       | `hold_fail_closed`       | exactly empty | any canonical length |

The complete sensitivity path set for `merge.signal.classified` is
`missionNodeId`, `evaluationId`, `groupId`, `signalVersion`, `memberIds`,
`memberIds[]`, `findingIds`, `findingIds[]`, `classification`, `reasonCode`,
`retryability`, `wakeKey`, and `disposition`; every path is `public`.

---

### 4.6 `merge.member.policy_blocked`

| Field               | Value                                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **name**            | `merge.member.policy_blocked`                                                                                                                                                                                                                            |
| **wave**            | W0                                                                                                                                                                                                                                                       |
| **status**          | `frozen`                                                                                                                                                                                                                                                 |
| **missionNodes**    | `mq-1`                                                                                                                                                                                                                                                   |
| **defaultSeverity** | `warn`                                                                                                                                                                                                                                                   |
| **semantic fact**   | Emitted **only** for a validated member-local deterministic-policy block. Proves one or more members were excluded for policy and one or more blocking findings were attributed; never represents infrastructure, product-decision, or unknown evidence. |
| **apexCorrelation** | `missionNodeId === "mq-1"` ∧ `evaluationId` ∧ `groupId` ∧ `classification === "deterministic_policy"` ∧ the non-empty canonical `memberIds` and `findingIds` match the policy evaluation.                                                                |
| **sources**         | Card `redrive/mq1-post928-prep:docs/roadmap/mission-complete/nodes/cards/mq-1.md`; Zod `MergeMemberPolicyBlockedPayload` and `sensitivityRules.mergeQueueAuthoritySignals.ts` @ `336ce4fbee9caf3b02aa9aab37ce77c74a5276f3`.                              |

**Payload (complete fixed strict object)**

| sensitivity path | exact zodHint                                                                           | tag      |
| ---------------- | --------------------------------------------------------------------------------------- | -------- |
| `missionNodeId`  | `z.literal("mq-1")`                                                                     | `public` |
| `evaluationId`   | `z.string().regex(/^mqeval_[0-9a-f]{64}$/u)`                                            | `public` |
| `groupId`        | `z.string().regex(/^mqgrp_[0-9a-f]{64}$/u)`                                             | `public` |
| `signalVersion`  | `z.literal("merge_signal.v1")`                                                          | `public` |
| `memberIds`      | `z.array(z.string().min(1))`; values equal `[...new Set(values)].sort()` and length > 0 | `public` |
| `memberIds[]`    | each `z.string().min(1)`                                                                | `public` |
| `findingIds`     | `z.array(z.string().min(1))`; values equal `[...new Set(values)].sort()` and length > 0 | `public` |
| `findingIds[]`   | each `z.string().min(1)`                                                                | `public` |
| `classification` | `z.literal("deterministic_policy")`                                                     | `public` |
| `reasonCode`     | `z.literal("audit_policy")`                                                             | `public` |
| `retryability`   | `z.literal("non_retryable")`                                                            | `public` |
| `wakeKey`        | `z.null()`                                                                              | `public` |
| `disposition`    | `z.literal("member_repair")`                                                            | `public` |

Those thirteen rows are the complete sensitivity path set for this event.

---

## 5. W0 summary table

| name                                   | severity | nodes | status   |
| -------------------------------------- | -------- | ----- | -------- |
| `integration.requirement.validated`    | `info`   | in-2  | `frozen` |
| `behavior.coverage.selection_analyzed` | `info`   | rv-4  | `frozen` |
| `governance.audit_posture.updated`     | `info`   | gv-1  | `frozen` |
| `review.simulated_intent`              | `info`   | gv-2  | `frozen` |
| `merge.signal.classified`              | `info`   | mq-1  | `frozen` |
| `merge.member.policy_blocked`          | `warn`   | mq-1  | `frozen` |

**W0 count: 6 frozen · 0 blocked_collision.**

---

## 6. W1-A frozen index — IN-7 author lifecycle

The exact durable obligations for these four rows live in
[`event-vocabulary-w1a-integration-author.md`](./event-vocabulary-w1a-integration-author.md).
That linked document extends this single freeze authority; it does not create a
second protocol or production registry.

| name                           | severity | nodes | status   |
| ------------------------------ | -------- | ----- | -------- |
| `integration.author.started`   | `ok`     | in-7  | `frozen` |
| `integration.author.attempt`   | `info`   | in-7  | `frozen` |
| `integration.author.succeeded` | `ok`     | in-7  | `frozen` |
| `integration.author.failed`    | `fail`   | in-7  | `frozen` |

**W1-A count: 4 frozen · 0 blocked_collision.** Source: merged PREP
`a4ea6eb040359d78dabc1b81e22e89978cb012fe`, audited five-path digest
`567e34152d34b54df59f38e37001d7b7f872522102ca56d808a3d527f3010ecf`.
The names are final obligations but are not registered, cataloged, emitted, or
eligible for consumer credit until their later units land.

---

## 7. EV-SUB-W0 implementer checklist (not this PR)

1. Schemas under `events/schemas/*` (`.strict()`), thin `registry.ts` import
   (file ≤500).
2. `eventDefaultSeverity` entries matching the table.
3. Sensitivity leaf coverage for every payload path (CI-hard).
4. `pnpm run codegen:events` → committed seed mirror.
5. Migration `0042`: `INSERT INTO event_types (name, default_severity) … ON CONFLICT DO NOTHING`.
6. Proofs: drift gate, real-PG append + FK, sensitivity coverage, RLS on
   `events`, no second writer.

---

## 8. Later waves (sketch only — not frozen)

| Wave | Illustrative content                                                                              |
| ---- | ------------------------------------------------------------------------------------------------- |
| W1+  | Remaining integrations lifecycle expansions, including deferred `integration.requirement.derived` |
| W2   | Runtime behavior.\* observation chain                                                             |
| W3   | Merge-queue group/subset/land_group chain                                                         |
| W4   | Back-half issue_loop / symptom / resolution family                                                |
| W5   | Governance F1–F5 remainder + designSystem family                                                  |

Each: SPEC-FREEZE → EV-SUB → consumer fanout. No global incomplete dump.
