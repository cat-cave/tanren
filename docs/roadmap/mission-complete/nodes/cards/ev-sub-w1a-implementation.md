# ev-sub-w1a-implementation — W1-A integration.author event vocabulary

**Phase**: Mission-complete event substrate (SP-8)
**Unit**: `EV-SUB-W1-A`
**Node credit**: **0**
**State**: Phase A non-migration substrate; migration deferred until free ≥0046-class slot
**Base**: `origin/main` / `d39369ec2788a7094c9a714dd7935e7fcbea5b0e`
**Branch**: `mission/in-7-evsub-w1a`
**Consumes**: [`spec-freeze-w1-a.md`](./spec-freeze-w1-a.md),
[`event-vocabulary-waves.md`](../../event-vocabulary-waves.md),
[`event-vocabulary-w1a-integration-author.md`](../../event-vocabulary-w1a-integration-author.md)
**Distinct from**: IN-7 producer + HTTP + UI + apex (later consumer node credit)

## Outcome

Install exactly the four frozen W1-A payload schemas through the sole SP-8 chain:

1. strict Zod payload schemas in the typed `EventRegistry` (canonical re-author;
   never spread or import PREP draft registry);
2. complete sensitivity paths — 16 public leaves, set-equal to freeze;
3. exact default severities (`ok` / `info` / `ok` / `fail`);
4. generated event-type seed and generated JSON contracts;
5. focused schema, severity, sensitivity, and seed unit tests; and
6. after IN-1 `0043`, RV-4 `0044`, and GV-3 `0045` land on `origin/main`, one
   additive ≥0046-class catalog migration (Phase B — **not** this Phase A commit).

This unit emits no production event and implements no consumer HTTP, UI, or
apex behavior. It cannot earn consumer-node credit.

## Exact path lease

### Phase A — immediate non-migration paths

| Path                                                                                                | Action                                                                  |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `docs/roadmap/mission-complete/nodes/cards/ev-sub-w1a-implementation.md`                            | This ownership and validation card                                      |
| `services/orchestrator/src/engine/events/schemas/eventVocabularyW1aIntegrationAuthor.ts`            | Four frozen strict payloads + `w1aEventRegistry` (canonical re-author)  |
| `services/orchestrator/src/engine/events/schemas/integrations.ts`                                   | Re-export `w1aEventRegistry` only (one line)                            |
| `services/orchestrator/src/engine/events/registry.ts`                                               | Import/spread `w1aEventRegistry` only (≤498 lines)                      |
| `services/orchestrator/src/engine/events/sensitivityRules.eventVocabularyW1aIntegrationAuthor.ts`   | Complete frozen W1-A sensitivity path sets (16 public leaves)           |
| `services/orchestrator/src/engine/events/sensitivityRules.ts`                                       | Import/spread W1-A rule set                                             |
| `services/orchestrator/src/engine/notifications/eventDefaultSeverity.ts`                            | Four explicit frozen severity entries                                   |
| `db/src/eventTypesSeed.ts`                                                                          | Generated mirror from `codegen:events`; never hand-edited               |
| `contracts/json/events/integration_author_started.json`                                             | Generated JSON contract                                                 |
| `contracts/json/events/integration_author_attempt.json`                                             | Generated JSON contract                                                 |
| `contracts/json/events/integration_author_succeeded.json`                                           | Generated JSON contract                                                 |
| `contracts/json/events/integration_author_failed.json`                                              | Generated JSON contract                                                 |
| `services/orchestrator/tests/eventVocabularyW1aIntegrationAuthor.test.ts`                           | Unit and drift-boundary proof                                           |
| `services/orchestrator/tests/prep/integrationAuthorEventPrep.test.ts`                               | Flip obsolete “no production registration” assertion; retain no-authority-import proof |

### Phase B — serialized migration paths (BLOCKED; do not author yet)

| Path                                                                                         | Action after 0043/0044/0045 on `origin/main`                                                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `db/migrations/004N_event_vocabulary_w1a.sql`                                                | Add only the four frozen catalog rows, idempotently (`004N` = free)                                                                   |
| `db/migrations/meta/004N_snapshot.json`                                                      | Schema-copy predecessor; fresh ID chained (no DDL)                                                                                    |
| `db/migrations/meta/_journal.json`                                                           | Append the serialized idx-N entry                                                                                                     |
| `services/orchestrator/tests/eventVocabularyW1aIntegrationAuthorCatalog.integration.test.ts` | **Not authored until the actual free migration slot exists.** When created, complete W0-shaped proof: `migrate()` + `PgEventStore` append + FK/catalog seed + RLS isolation + restart read-back (`eventVocabularyW0Catalog.integration.test.ts`). No guessed 0046–0048 filenames, no skip-stub body, no Phase A partial suite. |

**Never steal slots 0043 / 0044 / 0045.** Choose the then-free ≥0046-class index
only after predecessors land and this branch rebases onto that `main`.

**Phase A hard exclusion:** do not create
`eventVocabularyW1aIntegrationAuthorCatalog.integration.test.ts` (or any
stub/skip cosplay of the catalog proof) until Phase B authors the real
`004N` slot. Catalog/FK/RLS success is not claimable from Phase A.

No wildcard ownership. Any additional changed path requires this card to be
amended and committed before that path is edited.

## Frozen names and severities

| Name                           | Severity |
| ------------------------------ | -------- |
| `integration.author.started`   | `ok`     |
| `integration.author.attempt`   | `info`   |
| `integration.author.succeeded` | `ok`     |
| `integration.author.failed`    | `fail`   |

Payload fields, bounds, enums, and sensitivity leaves are copied exactly from
the W1-A freeze authority (and verified PREP shapes as isomorphic input). No
fifth name or silent reshape is permitted. Payloads have no `version` field.

### Strict payload field sets (envelope owns tenancy)

| Name      | Leaves                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| started   | `missionNodeId: "in-7"`, `unitId` (1..256)                                                                                             |
| attempt   | started + `attempt` (≥1 int), `bodyPreview` (≤500 via `AUTHORING_ATTEMPT_BODY_PREVIEW_MAX`), `canonicalSignature` (1..256), `rejection` (≤2000), `decision` enum |
| succeeded | started + `attempts` (≥1 int)                                                                                                          |
| failed    | started + `reason` (1..2000), `attempts` (≥0 int)                                                                                      |

All 16 leaves are `public`. No `orgId` / `projectId` / `runId` / credentials in payload.

## PREP disposition

- **Retain** PREP modules under `contracts/prep/` as test/draft input until IN-7.
- **Do not promote** `integrationAuthorEventPayloadDrafts` into `EventRegistry`.
- **Do not copy** the PREP factory into production.
- Re-author canonical schemas field-for-field from frozen shapes (no `Draft`
  suffix, no `prospective_unfrozen` constant, no PREP factory import).
- Flip the PREP test’s obsolete “no production registration” assertion: production
  **does** register the four names after Phase A; PREP still has **no**
  EventRegistry / EventStore / authority imports.

## 500-line plan

- `registry.ts` is 496 lines → import + spread only → target **498** (must remain thin).
- `sensitivityRules.ts` 475 → +2 spread lines.
- `integrations.ts` 487 → +1 re-export.
- `eventDefaultSeverity.ts` 309 → four severity entries + comment.
- New schema/sensitivity modules stay well under 500.
- Every authored source/docs file must remain at or below 500 lines.

## Hard exclusions

- All migrations / journal / snapshots until the free post-0045 slot is known
- Real catalog/FK claims that cannot execute without the migration
- Stub or skip-only catalog integration tests (guessed future slots, empty
  Phase-B TODO bodies, or “defers until migration” cosplay proofs)
- IN-7 producer, binding, kernel, `PgEventStore.append` call sites (Phase A)
- HTTP routes, dashboard UI, nav, `screens.ts`, apex harness
- EventStore changes, runtime `event_types` upsert, second catalog
- Aliases / synonyms with `fragment.authoring.*` or any fifth name
- W0 six names / schemas / migration 0042 (immutable)
- Stealing migration slots 0043–0045
- Full CI, smoke, Compose, Docker, push, or PR from this author worktree
- Node credit claim (this unit is always **0**)

## Validation

### Phase A (this branch)

1. focused W1-A unit tests only (`eventVocabularyW1aIntegrationAuthor.test.ts` + PREP flip);
2. updated PREP no-authority-import proof + production-registration flip;
3. `corepack pnpm run codegen:events` and event-seed content proof;
4. contract JSON generation via official generators (never hand-edit);
5. `export __ETC_BASHRC_SOURCED=1; just affected-typecheck origin/main`;
6. `just affected-test origin/main`;
7. all authored files ≤500 lines (`registry.ts` ≤498);
8. no catalog integration test file present.

### Phase B (after free slot)

1. append `004N` SQL/journal/snapshot only (real free index, no guessing);
2. author the complete W0-shaped gated real-Postgres catalog/FK/RLS/restart suite
   at `eventVocabularyW1aIntegrationAuthorCatalog.integration.test.ts`;
3. rerun narrow checks;
4. hand off full `just fast-check`, `just ci`, and `just smoke` to root publication.

## Credit and publication

EV-SUB-W1-A remains **zero credit** even after merge. IN-7 node credit only after
emit + HTTP + UI + live apex. This branch is local authoring only unless root
separately authorizes publication. Phase A is intentionally incomplete without
the catalog migration.
