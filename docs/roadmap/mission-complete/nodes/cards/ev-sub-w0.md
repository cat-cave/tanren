# ev-sub-w0 — SPEC-FREEZE-W0 event vocabulary (docs-only)

**Phase**: Mission-complete event substrate (SP-8 protocol)
**Node credit**: **0** (SPEC-FREEZE + later EV-SUB earn zero node credit)
**State**: docs freeze only — no migration, no emit, no consumer completion
**Base**: `origin/main` / `1f1eda2ed678f8ea7f12eef4a8362e22dbd39fee`
**Branch**: `mission/spec-freeze-w0-events`
**Authority**: [`event-vocabulary-waves.md`](../../event-vocabulary-waves.md)
**Purpose**: freeze exact W0 named-event strings, severities, complete strict
payload schemas, sensitivity paths, and runtime-behavior correlation so
**EV-SUB-W0** can install catalog rows and W0 consumers can emit without
per-node event-migration ownership.

## Outcome (exact)

Land a durable freeze authority that:

1. Resolves the IN-2 name collision: freeze
   `integration.requirement.validated` for the validate-HTTP proof; mark
   `integration.requirement.derived` as a **separate future compiler fact**
   (deferred, non-synonymous — not a blocked collision).
2. Admits five verified prep facts from train branches as authoritative W0
   strings: `behavior.coverage.selection_analyzed`,
   `governance.audit_posture.updated`, `review.simulated_intent`,
   `merge.signal.classified`, `merge.member.policy_blocked`.
3. Publishes the post-freeze migration map: `0041 CAS-SUB` → `0042 EV-SUB-W0`
   → `0043 IN-1` → `0044 RV-4 non-event schema` → `0045 GV-3 identity`.
4. Cancels exclusive event-catalog migration ownership for GV-1 / GV-2 / MQ-1;
   those nodes consume W0 catalog rows. Product dependency order among
   governance/merge-queue writers may still serialize where authorities
   overlap. IN-2 emit lands only after EV-SUB-W0.
5. Closes every payload decision in the durable authority: exact literals,
   regexes, union arms, field limits, cross-field invariants, and every
   sensitivity path. EV-SUB-W0 needs no prep branch and may invent no value.

This card is **not** EV-SUB-W0 (registry + seed + migration). That is a
separate zero-credit substrate PR after this freeze lands.

## Exclusive ownership (exactly two paths)

| Path                                                      | Role                                           |
| --------------------------------------------------------- | ---------------------------------------------- |
| `docs/roadmap/mission-complete/nodes/cards/ev-sub-w0.md`  | This ownership + gate card                     |
| `docs/roadmap/mission-complete/event-vocabulary-waves.md` | Durable freeze authority (W0 table + protocol) |

No wildcard ownership. No production code, schemas, generated files,
migrations, event registry, tests, nav, or screens.

## Exclusions (hard)

- `db/migrations/**`, `db/src/eventTypesSeed.ts`, journal/snapshot
- `services/orchestrator/src/engine/events/**` (registry, schemas, sensitivity)
- `services/orchestrator/src/engine/notifications/eventDefaultSeverity.ts`
- Consumer emit/HTTP/UI for in-2 / rv-4 / gv-1 / gv-2 / mq-1
- CAS-SUB `0041`, IN-1 lifecycle, GV-3 identity schema
- Push / open PR from this worktree (local commit only when gates green)

## Dependency / merge map

| Unit                      | Relation to this freeze                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **SPEC-FREEZE-W0** (this) | Docs only; may land before or parallel with CAS-SUB; **must** land before EV-SUB-W0 freezes implementable names |
| **CAS-SUB / 0041**        | Independent of event catalog; sole config-revision owner                                                        |
| **EV-SUB-W0 / 0042**      | Consumes this freeze; sole additive `event_types` INSERTs for W0 names                                          |
| **IN-2 emit + apex**      | After EV-SUB-W0; no migration; uses `integration.requirement.validated`                                         |
| **IN-1 / 0043**           | Lifecycle tables only; **no** event catalog ownership                                                           |
| **RV-4 / 0044**           | Coverage composite-FK / non-event schema only; event name pre-seeded by EV-SUB-W0                               |
| **GV-1 → GV-2 → MQ-1**    | Product + emit restacks; catalog pre-seeded; **no** exclusive catalog migrations                                |
| **GV-3 / 0045**           | Policy/gate land-identity CHECKs; not event catalog                                                             |

## Node-credit rule

| Unit                                           | Credit                                                       |
| ---------------------------------------------- | ------------------------------------------------------------ |
| SPEC-FREEZE-Wn (this)                          | **0**                                                        |
| EV-SUB-Wn                                      | **0** (SP-8 substrate)                                       |
| Consumer emit + HTTP + UI + apex (principle 8) | **1 node** when that node’s independent convergence GO holds |

Anti-patterns: counting freeze/EV-SUB as in-2/rv-4/… complete; counting
registry without emit+apex; hand-seed without migration; generic substitute
events as named proof.

## Proof gates (this PR)

| #   | Gate                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Every W0 name has exact string, severity, complete strict schema/constraints, every sensitivity path, runtime-behavior correlation, and source citation |
| F2  | Zero `blocked_collision` rows for names entering W0                                                                                                     |
| F3  | Alternatives (`derived`, `review.simulated.started`/`.verdict`) marked deferred/non-synonymous — not frozen as synonyms                                 |
| F4  | No invented names absent from freeze authority sources; no unresolved payload decision or prep-dependent definition                                     |
| P1  | Changed path set equals the two owned paths only                                                                                                        |
| P2  | Both files &lt; 500 lines                                                                                                                               |
| P3  | `just fast-check` + `just ci` green (docs-only); root-serialized `just smoke` **pending** (sibling work owns hardcoded ports)                           |
| P4  | Local commit only; no push / no PR                                                                                                                      |

## Authority sources inspected (read-only)

- Mission README + six bucket specs / split companions + frozen
  `build-workflow.mjs.txt`
- Fanout audit:
  `/home/trevor/projects/tanren/.codex/orchestration-prompts/consumer-event-vocabulary-fanout-grok-report.md`
- IN-2 convergence:
  `/home/trevor/projects/tanren/.codex/orchestration-prompts/in2-b5edc573-grok-convergence-report.md`
  - branch `mission/in-2-integration-requirement-contracts` @ `b5edc57318245d778a52e3f63cb8e4a579a7da2b`
- Prep schemas/sensitivity: `redrive/rv-4-post943` @ `c601cae77419a1ef16f805f1a5fe7b708c394b6b`,
  `node/gv-1-audit-posture-write-guard` @ `b8099d6a85f806954192f925a21385fd9fba9922`,
  `node/gv-2-simulated-review-publication` @ `ef2893f774acd9b778f888f9e2e807150d71f040`,
  and `redrive/mq1-post928-prep` @ `336ce4fbee9caf3b02aa9aab37ce77c74a5276f3`
- Main SP-8: `EventRegistry` / `eventDefaultSeverity` / `Sensitivity`
  (`public` \| `redacted` \| `secret`) / `PgEventStore` envelope
  (`orgId` required; `projectId` optional; payload Zod-strict)

## Out of scope for W0 freeze

Aspirational W1+ names from bucket apex chains (full runtime behavior.\*,
integrations lifecycle, merge-queue group/subset, back-half issue_loop,
governance F1–F5 remainder, designSystem.\*). Those require later SPEC-FREEZE
waves — never a global incomplete dump.
