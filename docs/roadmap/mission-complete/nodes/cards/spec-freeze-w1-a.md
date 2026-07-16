# spec-freeze-w1-a — IN-7 author event vocabulary freeze

**Phase**: Mission-complete event substrate (SP-8)
**Unit**: `SPEC-FREEZE-W1-A`
**Node credit**: **0**
**State**: card-first docs-freeze lease; no registry, catalog, or producer
**Base**: `origin/main` @ `4e02f707096b26d8390cbc7fbb5248b495b7c397`
**Branch**: `mission/in-7-spec-freeze-w1a`
**Consumes**: merged IN-7 PREP @ `a4ea6eb040359d78dabc1b81e22e89978cb012fe`
with five-path manifest digest
`567e34152d34b54df59f38e37001d7b7f872522102ca56d808a3d527f3010ecf`

## Outcome

Freeze exactly these four family-owned SP-2 lifecycle names:

| Final name                     | Severity | Sole producer |
| ------------------------------ | -------- | ------------- |
| `integration.author.started`   | `ok`     | `in-7`        |
| `integration.author.attempt`   | `info`   | `in-7`        |
| `integration.author.succeeded` | `ok`     | `in-7`        |
| `integration.author.failed`    | `fail`   | `in-7`        |

The durable freeze must be self-contained: exact strict payload fields and
bounds, complete sensitivity leaves, envelope identity, lifecycle bindings,
firing eligibility, throw-safe emit doctrine, apex correlation, collision
decisions, and negative authority pins. It freezes obligations only. A later
EV-SUB-W1-A implements the sole production Zod/catalog path and also earns
zero node credit.

## Dependencies and ordering

```text
merged PREP (credit 0)
  -> SPEC-FREEZE-W1-A (this docs-only unit; credit 0)
  -> EV-SUB-W1-A (registry/seed/migration; credit 0)
  -> IN-7 producer + HTTP + UI + live apex proof (node credit)
```

No IN-1 lifecycle table or SP-2 kernel implementation is required to freeze
these verified contract obligations.

## Exact exclusive path lease

| Path                                                                       | Role                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------- |
| `docs/roadmap/mission-complete/nodes/cards/spec-freeze-w1-a.md`            | Ownership, dependency, exclusion, and validation card   |
| `docs/roadmap/mission-complete/event-vocabulary-waves.md`                  | Durable W1-A freeze authority and EV-SUB handoff index  |
| `docs/roadmap/mission-complete/event-vocabulary-w1a-integration-author.md` | Linked durable W1-A contract rows and exact obligations |

No wildcard ownership. The line-cap contingency is invoked: waves starts at
384 lines, and the exact W1-A payload, sensitivity, producer, collision,
replay, and negative-control obligations cannot fit in its remaining 116 lines.
The named detail file is one linked extension of the same freeze authority,
not a second protocol. It must not exist until this lease amendment is
committed.

## Merged PREP provenance

| Input          | Exact pin                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| Payload drafts | `integrationAuthorEventPayloads.ts` SHA-256 `24b263a859fd20c0f3e442630aad3d5819355d6eee2080ef9d2dd91dca991951` |
| Factory draft  | `integrationAuthorEventFactory.ts` SHA-256 `6794e8aff4950a817c7829dd3845de51c2e690dbd89ab942f27cc9b597687091`  |
| PREP prose     | `integration-author-events.md` SHA-256 `18c7556ec0744586145ffd4139ba5fd13534346277e1ca50276bc80bbd3df5e7`      |

If those accepted semantics move without a new GO audit, the freeze must stop.

## Frozen decision boundary

- Payloads are strict, flat objects. The envelope owns required `orgId` and
  optional non-empty `runId`; payloads never duplicate tenancy.
- `missionNodeId` is the literal `"in-7"`; `unitId` comes only from the SP-2
  lifecycle point. `spec`, `draft`, `validated`, row ids, credentials, and
  proof/CAS digests are forbidden projections.
- Delivery is best-effort observability outside family persistence. Sink
  failure is warned and swallowed; the validated, non-retracted family row is
  the only product authority.
- A complete unit trace has exactly one terminal: `succeeded` XOR `failed`.
  Success requires persistence, passed whole-batch compose, and no retraction;
  post-batch failure requires retraction before emit.
- `fragment.authoring.*` is template F2 only and is never an IN-7 synonym,
  alias, producer event, or apex substitute.
- No automatic EventStore idempotency or row/event same-transaction claim is
  frozen. Breaking payload changes require a later explicit freeze protocol,
  never a silent reshape.

## Hard exclusions

- Production event schemas, `events/registry.ts`, sensitivity runtime, default
  severity, codegen, `eventTypesSeed.ts`, generated contracts
- `db/migrations/**`, journal, snapshots, or a migration-slot reservation
- PREP source/tests, SP-2 kernel code, EventStore, persistence, or producers
- IN-7 product rows, HTTP, dashboard UI, nav, screens, or apex harness
- Any fifth event name, including requirement derivation/supersession, A3,
  delivery, grant, or resource-provision facts
- Generic or aliased `fragment.authoring.*` events and any parallel catalog
- MergeAuthority, CAS, proof, gate, or land authority

## Proof gates

| Gate | Requirement                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| F1   | Four exact strings; strict fields/bounds/enums; exact severity; complete public sensitivity; sole producer; apex correlation; PREP pins |
| F2   | Zero `blocked_collision` among the four                                                                                                 |
| F3   | Template/sibling/W0/deferred collision decisions remain non-synonymous                                                                  |
| F4   | No fifth name, same-transaction claim, idempotency invention, or deferred fact promoted                                                 |
| P1   | Changed paths equal this exclusive lease only                                                                                           |
| P2   | Every owned file remains below 500 lines                                                                                                |
| P3   | Relevant docs/architecture/affected checks, then `just fast-check`, `just ci`, and root-serialized `just smoke`                         |
| P4   | Local commit only until the orchestrating root separately authorizes publication                                                        |

## Credit and handoff

This freeze remains zero credit after merge. EV-SUB-W1-A remains zero credit
after installation. IN-7 can earn node credit only when the real consumer emits
the installed names and is independently callable through HTTP, visible in the
dashboard, and proven by live apex correlation. Do not push or open a PR from
this author worktree.
