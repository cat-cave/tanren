# Event vocabulary waves — freeze authority

**Status**: W0 frozen (SPEC-FREEZE-W0)  
**Base**: `origin/main` / `1f1eda2ed678f8ea7f12eef4a8362e22dbd39fee`  
**Latest landed migration on main**: `0040_event_vocabulary.sql`  
**Card**: [`nodes/cards/ev-sub-w0.md`](./nodes/cards/ev-sub-w0.md)  
**Node credit**: freeze = 0 · EV-SUB = 0 · consumer emit+apex = node credit

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

| Slot         | Owner                  | Purpose                                                                                                              |
| ------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **0041**     | **CAS-SUB**            | `config_revision` + sole `ProjectStore` CAS (not event catalog)                                                      |
| **0042**     | **EV-SUB-W0**          | Additive `event_types` INSERTs for **frozen W0 names only** + registry/severity/sensitivity/codegen mirror           |
| **0043**     | **IN-1**               | `integration_lifecycle` clean-replacement (no vocabulary ownership)                                                  |
| **0044**     | **RV-4**               | Coverage composite-FK / non-event schema only; **strip** catalog ownership of `behavior.coverage.selection_analyzed` |
| **(no mig)** | **GV-1 / GV-2 / MQ-1** | Product + emit restacks; catalog pre-seeded by EV-SUB-W0                                                             |
| **0045**     | **GV-3**               | Policy/gate land-identity CHECKs / purge (not event catalog)                                                         |

**Product order note:** GV-1 → GV-2 → MQ-1 may still serialize where they share
MergeAuthority / governance writers; that is **not** a 1:1 catalog-migration
chain. **IN-2 emit** after EV-SUB-W0 (not after IN-1). SPEC-FREEZE and EV-SUB
earn **zero** node credit.

---

## 3. Deferred / non-synonymous alternatives (not W0 collisions)

| Name / family                                                                                                                                  | Relation                                                                                                                                       | Status                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `integration.requirement.derived`                                                                                                              | Future **compiler** fact (requirement derived from behaviors/specs). **Not** a synonym of `validated` (HTTP validate-success proof).           | `deferred` (later integrations wave) |
| `integration.requirement.superseded`                                                                                                           | Lifecycle successor of a derived requirement.                                                                                                  | `deferred`                           |
| `review.simulated.started`                                                                                                                     | Later **execution** fact when simulated publication I/O begins. Distinct from durable intent `review.simulated_intent`.                        | `deferred`                           |
| `review.simulated.verdict`                                                                                                                     | Later **execution** terminal simulated verdict fact. Distinct from intent and from forge-bound `review.approved` / `review.changes_requested`. | `deferred`                           |
| Full bucket apex chains (runtime behavior.\*, integrations lifecycle, mq group/subset, back-half, governance F1–F5 remainder, designSystem.\*) | Incomplete / under-specified for one dump                                                                                                      | `deferred` (W1+)                     |

These are **explicitly not** `blocked_collision` against W0 winners.

---

## 4. W0 frozen rows

### 4.1 `integration.requirement.validated`

| Field               | Value                                                                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **name**            | `integration.requirement.validated`                                                                                                                                                                                                                                   |
| **wave**            | W0                                                                                                                                                                                                                                                                    |
| **status**          | `frozen`                                                                                                                                                                                                                                                              |
| **missionNodes**    | `in-2`                                                                                                                                                                                                                                                                |
| **defaultSeverity** | `info`                                                                                                                                                                                                                                                                |
| **semantic fact**   | A caller-supplied `IntegrationRequirementV1` passed strict semantic validation and its canonical identities were produced (domain-separated `requirementDigest` + CAS content artifact). This is the **IN-2 validate-HTTP proof**. It is **not** compiler derivation. |
| **payload fields**  | See table below                                                                                                                                                                                                                                                       |
| **apexCorrelation** | `missionNodeId === "in-2"` ∧ `requirementDigest` ∧ `artifact.digest` match the validate response / CAS identity                                                                                                                                                       |
| **sources**         | Card `mission/in-2-integration-requirement-contracts:nodes/cards/in-2.md`; route success body `routes/integrationContracts/index.ts` @ `b5edc573…`; IN-2 convergence report R1; fanout audit §3.4–§6.2; integrations apex cites `derived` (deferred, non-synonym)     |

**Payload (strict; envelope owns `orgId`)**

| path                 | zodHint                                          | sensitivity |
| -------------------- | ------------------------------------------------ | ----------- |
| `missionNodeId`      | `z.literal("in-2")`                              | `public`    |
| `requirementDigest`  | `z.string()` branded digest (`sha256:` + 64 hex) | `public`    |
| `artifact.digest`    | same digest brand                                | `public`    |
| `artifact.byteSize`  | `z.number().int().nonnegative()`                 | `public`    |
| `artifact.mediaType` | `z.literal` of IN-2 requirement media type       | `public`    |
| `capability`         | `z.string().min(1)` (requirement identity echo)  | `public`    |
| `plane`              | requirement plane enum (product \| control)      | `public`    |
| `direction`          | requirement direction enum                       | `public`    |
| `criticality`        | requirement criticality enum                     | `public`    |

**Collision resolution:** Winner = `validated` for validate-HTTP.  
`integration.requirement.derived` remains a separate future fact (`deferred`).

---

### 4.2 `behavior.coverage.selection_analyzed`

| Field               | Value                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **name**            | `behavior.coverage.selection_analyzed`                                                                                                                                                                                 |
| **wave**            | W0                                                                                                                                                                                                                     |
| **status**          | `frozen`                                                                                                                                                                                                               |
| **missionNodes**    | `rv-4`                                                                                                                                                                                                                 |
| **defaultSeverity** | `info`                                                                                                                                                                                                                 |
| **semantic fact**   | Durable, replayable affected-selection proof: which active behavior revisions were selected (or explicitly excluded) for a set of changed targets under fail-closed coverage edges. Org/project live on the event row. |
| **apexCorrelation** | `analysisId` + selected/excluded `behaviorRevisionId` sets + `changedTargets` match the selection run under test                                                                                                       |
| **sources**         | Card `redrive/rv-4-post943:…/cards/rv-4.md`; Zod `BehaviorCoverageSelectionAnalyzedPayload` + sensitivity `sensitivityRules.runtimeVerification.ts` on that ref (`c601cae7…`)                                          |

**Payload (strict; from prep Zod)**

| path               | zodHint                                                                                                                                                                                                   | sensitivity |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `version`          | `z.literal("v1")`                                                                                                                                                                                         | `public`    |
| `analysisId`       | `z.string().min(1)`                                                                                                                                                                                       | `public`    |
| `mode`             | `z.enum(["targeted","expanded_unknown","no_active_behaviors"])`                                                                                                                                           | `public`    |
| `changedTargets[]` | `{ kind: AffectedTargetKind, targetRef: string }`                                                                                                                                                         | `public`    |
| `unknownTargets[]` | same shape                                                                                                                                                                                                | `public`    |
| `selected[]`       | `{ behaviorRevisionId, reasons[] }` — reasons discriminated union (`direct_edge` \| `transitive_dependency` \| `unknown_target` \| `uncovered_behavior` \| `dangling_dependency` \| `no_changed_targets`) | `public`    |
| `excluded[]`       | `{ behaviorRevisionId, reason: "no_reachable_changed_target", inspectedEdgeIds[] }`                                                                                                                       | `public`    |

EV-SUB must register leaf sensitivity paths for nested reason fields as in the
prep sensitivity module (all `public`).

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
| **sources**         | Card `node/gv-1-audit-posture-write-guard:…/cards/gv-1.md`; Zod `GovernanceAuditPostureUpdatedPayload` + `sensitivityRules.governance.ts` on that ref (`b8099d6a…`); `AuditPostureConfig` leaves                                                                          |

**Payload (strict)**

| path                             | zodHint                                  | sensitivity |
| -------------------------------- | ---------------------------------------- | ----------- |
| `actorUserId`                    | `z.string().min(1)`                      | `public`    |
| `previous.blockReviewAt`         | `z.enum(["P0","P1","P2","P3"])`          | `public`    |
| `previous.p2p3Handling`          | `z.enum(["fix-if-idle","route-to-dag"])` | `public`    |
| `previous.autonomousRemediation` | `z.boolean()`                            | `public`    |
| `current.blockReviewAt`          | same                                     | `public`    |
| `current.p2p3Handling`           | same                                     | `public`    |
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
| **sources**         | Card `node/gv-2-simulated-review-publication:…/cards/gv-2.md`; Zod `ReviewSimulatedIntentPayload` + `sensitivityRules.review.ts` on that ref (`ef2893f7…`)                                                                                                                                               |

**Payload (strict + cross-field cohere)**

| path            | zodHint                                                    | sensitivity |
| --------------- | ---------------------------------------------------------- | ----------- |
| `headSha`       | `z.string().regex(/^[0-9a-fA-F]{40}$/)`                    | `public`    |
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
| **sources**         | Card `redrive/mq1-post928-prep:…/cards/mq-1.md`; Zod `MergeSignalClassifiedPayload` + `sensitivityRules.mergeQueueAuthoritySignals.ts` on that ref (`336ce4fb…`)                                                                                                                      |

**Payload (discriminated union; common identity + variant fields)**

| path             | zodHint                                                                                                           | sensitivity |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | ----------- |
| `missionNodeId`  | `z.literal("mq-1")`                                                                                               | `public`    |
| `evaluationId`   | brand regex from mq-1 prep (`DerivedEvaluationId`)                                                                | `public`    |
| `groupId`        | brand regex from mq-1 prep (`DerivedGroupId`)                                                                     | `public`    |
| `signalVersion`  | `z.literal("merge_signal.v1")`                                                                                    | `public`    |
| `memberIds[]`    | sorted unique non-empty strings (empty for non-policy)                                                            | `public`    |
| `findingIds[]`   | sorted unique (empty for non-policy)                                                                              | `public`    |
| `classification` | closed enum of four kinds                                                                                         | `public`    |
| `reasonCode`     | closed per-kind enum (e.g. `audit_policy`, infra codes, product/unknown codes)                                    | `public`    |
| `retryability`   | `non_retryable` \| `retryable` \| `unknown` per kind                                                              | `public`    |
| `wakeKey`        | brand regex from mq-1 prep (`DerivedWakeKey`) or `null` per kind                                                  | `public`    |
| `disposition`    | closed per-kind literal (`member_repair` \| `retry_when_ready` \| `await_product_decision` \| `hold_fail_closed`) | `public`    |

---

### 4.6 `merge.member.policy_blocked`

| Field               | Value                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **name**            | `merge.member.policy_blocked`                                                                                                                                                                                             |
| **wave**            | W0                                                                                                                                                                                                                        |
| **status**          | `frozen`                                                                                                                                                                                                                  |
| **missionNodes**    | `mq-1`                                                                                                                                                                                                                    |
| **defaultSeverity** | `warn`                                                                                                                                                                                                                    |
| **semantic fact**   | Emitted **only** for a validated member-local **deterministic policy** block (same shape as the `deterministic_policy` arm of `merge.signal.classified`). Proves a member was excluded for policy — never infrastructure. |
| **apexCorrelation** | Same identity fields as §4.5 with `classification === "deterministic_policy"`, non-empty `memberIds` + `findingIds`                                                                                                       |
| **sources**         | Same mq-1 prep ref; Zod `MergeMemberPolicyBlockedPayload` ≡ `DeterministicPolicy` arm                                                                                                                                     |

**Payload:** identical field set and sensitivity as the `deterministic_policy`
arm of §4.5 (`classification` fixed to that literal; `reasonCode: "audit_policy"`;
`retryability: "non_retryable"`; `wakeKey: null`; `disposition: "member_repair"`;
`memberIds`/`findingIds` non-empty).

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

## 6. EV-SUB-W0 implementer checklist (not this PR)

1. Schemas under `events/schemas/*` (`.strict()`), thin `registry.ts` import
   (file ≤500).
2. `eventDefaultSeverity` entries matching the table.
3. Sensitivity leaf coverage for every payload path (CI-hard).
4. `pnpm run codegen:events` → committed seed mirror.
5. Migration `0042`: `INSERT INTO event_types (name, default_severity) … ON CONFLICT DO NOTHING`.
6. Proofs: drift gate, real-PG append + FK, sensitivity coverage, RLS on
   `events`, no second writer.

---

## 7. Later waves (sketch only — not frozen)

| Wave | Illustrative content                                                              |
| ---- | --------------------------------------------------------------------------------- |
| W1   | Integrations lifecycle exact expansions (incl. `integration.requirement.derived`) |
| W2   | Runtime behavior.\* observation chain                                             |
| W3   | Merge-queue group/subset/land_group chain                                         |
| W4   | Back-half issue_loop / symptom / resolution family                                |
| W5   | Governance F1–F5 remainder + designSystem family                                  |

Each: SPEC-FREEZE → EV-SUB → consumer fanout. No global incomplete dump.
