<!-- cspell:ignore mqeval mqgrp mqwake -->

# mq-1 — authority-signal classification (post-EV consumer)

**Phase**: MVP (merge-queue)
**Node ID**: `mq-1`
**Base**: `origin/main` @ `67d9363fe220e1f280ed706a0b80af2b16724362` (#960 EV-SUB-W0)
**Branch**: `mission/mq-1-clean-post-ev`
**Node credit (this branch)**: **0** until independent audit + green gates + merge
**Purpose**: make a member-attributed deterministic policy block (v96 class: member C
P1) **impossible** to mislabel as infrastructure, emit the W0 facts through the sole
`EventStore`, cut the live settle/land/batch path over, and expose HTTP + dashboard.

## Consumes (do not redefine)

| Dependency                                                                   | Status on this base                                               |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| SP-4 `MergeAuthorityV2` (`authorizeLand` / `LandAuthorization` / envelope)   | on main                                                           |
| SPEC-FREEZE-W0 payload algebra (`disposition`, `mqeval_`/`mqgrp_`/`mqwake_`) | freeze authority                                                  |
| EV-SUB-W0 / #960 / migration `0042`                                          | **merged** — catalog + Zod + sensitivity + seed                   |
| SP-8 sole registry path                                                      | W0 owns `merge.signal.classified` + `merge.member.policy_blocked` |

**No migration.** MQ-1 is product + emit only. Catalog rows already exist via `0042`.

## Exact exclusive ownership

| Path                                                                             | Role                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `docs/roadmap/mission-complete/nodes/cards/mq-1.md`                              | this card                                                          |
| `services/orchestrator/src/engine/merge/authoritySignalClassification.ts`        | MA-V2-bound classify + EventStore append                           |
| `services/orchestrator/src/engine/merge/authoritySignalLandBlock.ts`             | land-path re-authorize + classify wire (keeps mergeLandPaths ≤500) |
| `services/orchestrator/src/routes/mergeQueue/authoritySignals.ts`                | org/project-authorized projection + list                           |
| `services/orchestrator/tests/authoritySignalClassification.test.ts`              | unit + EventStore order + v96 policy≠infra                         |
| `services/orchestrator/tests/mergeQueueAuthoritySignalsRoutes.test.ts`           | HTTP authz / list / evaluation                                     |
| `services/orchestrator/tests/mergeQueueAuthoritySignals.rls.integration.test.ts` | real-Postgres RLS (gated)                                          |
| `services/orchestrator/tests/mq1AuthoritySettleCutover.test.ts`                  | production settle/land/batch regression                            |
| `services/dashboard/src/api/mergeQueueAuthoritySignals.ts`                       | typed BFF client (W0 shapes)                                       |
| `services/dashboard/src/components/mergeQueue/AuthoritySignalPanel.tsx`          | visible non-green panel                                            |
| `services/dashboard/tests/mergeQueueAuthoritySignals.render.test.ts`             | four-state render proof                                            |

## Soft leases (thin wire only — no ownership expansion)

| Path                                                                      | Allowed edit                                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `services/orchestrator/src/engine/merge/batchCoordinator.ts`              | continue after member-policy dequeue; never whole-batch infra for attributed P1  |
| `services/orchestrator/src/engine/merge/batchCoordinatorSettle.ts`        | settle classified policy as member repair, never recoverable infra hold          |
| `services/orchestrator/src/engine/merge/recoverableDriveHold.ts`          | refuse `merge.queue.infra_blocked` for classified member-policy outcomes         |
| `services/orchestrator/src/engine/merge/batchInfraEscalate.ts`            | never escalate a policy-classified member as batch workspace infra               |
| `services/orchestrator/src/engine/workflow/reviewMerge/mergeLandPaths.ts` | classify+append on authority block; map `member_repair` → failed (writer repair) |
| `services/orchestrator/src/routes/experiments/mount.ts`                   | mount authority-signal routes only                                               |
| `services/dashboard/src/routes/mergeQueue/index.tsx`                      | fetch latest signals; pass panel props                                           |
| `services/dashboard/src/components/mergeQueue/MergeQueueBody.tsx`         | compose `<AuthoritySignalPanel />` only                                          |

## Hard exclusions

- `db/migrations/**` (no MQ-1 migration slot)
- `db/src/eventTypesSeed.ts`, W0 JSON contracts, `eventVocabularyW0.ts`, registry /
  sensitivity / severity / seed dual-path edits
- `mergeAuthorityGate.ts` (do not edit; consume only)
- Second event store / hand catalog upserts outside real-PG proofs after migrate
- Shared spine contract shape changes (`mergeAuthority.ts` field set)
- Foreign active leases (IN-1 lifecycle, IN-2 contracts, #856 BFF) — **zero overlap**
  with this exact lease (rechecked 2026-07-16)

## Classifier contract (exact)

1. **Authority binding.** Classification consumes real `AuthorizeLandInput` +
   `LandBindingEnvelope` + `LandAuthorization` (or typed infrastructure evidence).
   Caller-supplied policy/infra **labels** are not authority.
2. **W0 payload algebra.** Emit only `MergeSignalClassifiedPayload` /
   `MergeMemberPolicyBlockedPayload` from `eventVocabularyW0.ts`: `disposition`
   (never `repairRoute`), canonical `mqeval_`/`mqgrp_`/`mqwake_`, exact reason /
   retry / wake / member / finding constraints.
3. **Append order.** Sole `EventStore` / `PgEventStore`. Policy-blocked emits
   `merge.signal.classified` then `merge.member.policy_blocked`. Infra / product /
   unknown never emit policy-blocked.
4. **Production cutover.** A member-attributed P1 cannot enter
   `holdOrHaltRecoverableDrive` → `merge.queue.infra_blocked`, cannot escalate the
   whole batch via `batchInfraEscalate`, and routes to **member repair** while
   siblings remain eligible.
5. **HTTP + UI.** Mounted list + evaluation projection under org/project auth;
   cross-org fail-closed 404 parity; dashboard panel renders W0 fields including
   `disposition` (four closed states, never green-on-empty).

## Proof matrix (required for node credit)

| ID     | Proof                                                                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| MQ1-P1 | Attributed single-member P1 → `deterministic_policy` / `member_repair` / non-empty members+findings                                                |
| MQ1-P2 | EventStore append order: classified then policy_blocked; infra emits classified only                                                               |
| MQ1-P3 | HTTP list without evaluation id + evaluation fetch; cross-org 404 same shape                                                                       |
| MQ1-P4 | Real-Postgres RLS (`TANREN_RLS_DB_TEST=1`) — no hand catalog seed after #960                                                                       |
| MQ1-P5 | Dashboard four states non-green; shows `disposition`                                                                                               |
| MQ1-P6 | **v96 regression**: member C policy → member repair; five eligible siblings can proceed; **no** `merge.queue.infra_blocked` for C’s policy finding |
| MQ1-N1 | Typed infra timeout → retryable, empty members/findings                                                                                            |
| MQ1-N2 | Untyped `Error` → `unknown_fail_closed` / `untyped_evidence` (never infra)                                                                         |
| MQ1-N3 | Multi-member unattributed policy → `unattributed_policy` fail-closed                                                                               |
| MQ1-N4 | Files ≤500 lines (or documented architecture exception)                                                                                            |

## Anti-patterns (forbidden)

- Cherry-pick / restack stale `f78a0a77` wholesale
- Parallel Zod/schema/registry/seed for the two W0 merge events
- Helper-only classify without land/settle/batch wire
- Caller-supplied `evaluationId` / `repairRoute` / free wake keys as authority
- Claiming node complete before independent audit + `just fast-check` / ci / smoke

## Active peer lease check (read-only, pre-commit)

| Peer                                            | Exclusive overlap with this lease     |
| ----------------------------------------------- | ------------------------------------- |
| IN-1 (`in-1-final-fold`)                        | **none**                              |
| IN-2 (`in-2-integration-requirement-contracts`) | **none**                              |
| #856 (`pr-856-final`)                           | **none**                              |
| W0 / #960                                       | consume only (catalog already landed) |
