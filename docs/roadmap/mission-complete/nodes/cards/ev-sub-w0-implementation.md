# ev-sub-w0-implementation — W0 event vocabulary substrate

**Phase**: Mission-complete event substrate (SP-8)
**Node credit**: **0**
**State**: production complete; migration authorized after CAS-SUB landed
**Base**: `origin/main` / `55c53ab1f07abce4cf29a53411b44a2eddf0828e`
**Branch**: `mission/ev-sub-w0`
**Consumes**: [`event-vocabulary-waves.md`](../../event-vocabulary-waves.md)
**Distinct from**: [`ev-sub-w0.md`](./ev-sub-w0.md), the landed docs-only freeze card

## Outcome

Install exactly the six frozen W0 payload schemas through the sole SP-8 chain:

1. strict Zod payload schemas in the typed `EventRegistry`;
2. complete sensitivity paths using only `public`;
3. exact default severities (five `info`, `merge.member.policy_blocked` `warn`);
4. generated event-type seed and generated JSON contracts;
5. focused schema, invariant, severity, sensitivity, and catalog tests; and
6. after CAS-SUB lands, one additive `0042` catalog migration.

This unit emits no production event and implements no consumer HTTP, UI, or
apex behavior. It cannot earn consumer-node credit.

## Exact path lease

### Immediate non-migration paths

| Path                                                                            | Action                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `docs/roadmap/mission-complete/nodes/cards/ev-sub-w0-implementation.md`         | This ownership and validation card                            |
| `services/orchestrator/src/engine/events/schemas/eventVocabularyW0.ts`          | Six frozen strict payload schemas and `w0EventRegistry`       |
| `services/orchestrator/src/engine/events/schemas/integrations.ts`               | Extract existing hello entries into `helloEventRegistry` only |
| `services/orchestrator/src/engine/events/registry.ts`                           | Import/spread `helloEventRegistry` and `w0EventRegistry`      |
| `services/orchestrator/src/engine/events/sensitivityRules.benchmark.ts`         | Extract existing benchmark sensitivity rules only             |
| `services/orchestrator/src/engine/events/sensitivityRules.eventVocabularyW0.ts` | Complete frozen W0 sensitivity path sets                      |
| `services/orchestrator/src/engine/events/sensitivityRules.ts`                   | Import/spread extracted benchmark and W0 rule sets            |
| `services/orchestrator/src/engine/notifications/eventDefaultSeverity.ts`        | Six explicit frozen severity entries                          |
| `db/src/eventTypesSeed.ts`                                                      | Generated mirror from `codegen:events`; never hand-edited     |
| `contracts/json/events/integration_requirement_validated.json`                  | Generated JSON contract                                       |
| `contracts/json/events/behavior_coverage_selection_analyzed.json`               | Generated JSON contract                                       |
| `contracts/json/events/governance_audit_posture_updated.json`                   | Generated JSON contract                                       |
| `contracts/json/events/review_simulated_intent.json`                            | Generated JSON contract                                       |
| `contracts/json/events/merge_signal_classified.json`                            | Generated JSON contract                                       |
| `contracts/json/events/merge_member_policy_blocked.json`                        | Generated JSON contract                                       |
| `services/orchestrator/tests/eventVocabularyW0.test.ts`                         | Unit and drift-boundary proof                                 |
| `services/orchestrator/tests/eventVocabularyW0Catalog.integration.test.ts`      | Gated real-Postgres catalog/FK/RLS append proof               |

### Serialized migration paths — authorized after CAS-SUB landed

| Path                                         | Action after CAS-SUB `0041` is on `origin/main`       |
| -------------------------------------------- | ----------------------------------------------------- |
| `db/migrations/0042_event_vocabulary_w0.sql` | Add only the six frozen catalog rows, idempotently    |
| `db/migrations/meta/0042_snapshot.json`      | Schema-copy `0041`; fresh ID chained to 0041 (no DDL) |
| `db/migrations/meta/_journal.json`           | Append the serialized idx-42 entry                    |

No wildcard ownership. Any additional changed path requires this card to be
amended and committed before that path is edited.

## Frozen names and severities

| Name                                   | Severity |
| -------------------------------------- | -------- |
| `integration.requirement.validated`    | `info`   |
| `behavior.coverage.selection_analyzed` | `info`   |
| `governance.audit_posture.updated`     | `info`   |
| `review.simulated_intent`              | `info`   |
| `merge.signal.classified`              | `info`   |
| `merge.member.policy_blocked`          | `warn`   |

The payload fields, literals, regexes, union arms, cross-field invariants, and
sensitivity paths are copied exactly from `event-vocabulary-waves.md`. No new
name or payload decision is permitted here.

## 500-line plan

- `registry.ts` begins at exactly 500 lines. Replace its four inline hello
  entries with `helloEventRegistry` exported by their existing schema module,
  then spread `w0EventRegistry`.
- `sensitivityRules.ts` begins at exactly 500 lines. Move only the existing
  `benchmark.accept.passed` and `benchmark.accept.failed` rules to
  `sensitivityRules.benchmark.ts`, spread them back, then spread W0 rules.
- Every authored source/config/docs file must remain at or below 500 lines.

These are mechanical extractions; event names, schemas, sensitivities, and
runtime behavior must remain byte-for-byte equivalent at the public boundary.

## Hard exclusions

- Consumer producers or `PgEventStore.append` call sites
- IN-2/RV-4/GV-1/GV-2/MQ-1 HTTP, UI, routes, nav, or apex tests
- Any event not frozen in W0, including `integration.requirement.derived`,
  `review.simulated.started`, and `review.simulated.verdict`
- Runtime catalog upserts, a second seed/catalog, or direct `events` writes
- CAS-SUB `0041`, final IN-1 `0043`, RV-4 `0044`, or GV-3 `0045`
- Migration/journal/snapshot edits before CAS-SUB lands
- Full CI, smoke, Compose, or Vault from this author worktree

## Validation

Before the migration is authorized:

1. focused W0 unit tests;
2. existing event registry, semantic-field, severity, drift, and contract-schema tests;
3. `corepack pnpm run codegen:events` and `check:event-drift`;
4. contract JSON generation and `check:contract-schema-drift`;
5. `just affected-typecheck` and `just affected-test`;
6. architecture/format checks proving all authored files stay within 500 lines.

After CAS-SUB lands and this branch rebases:

1. append `0042` SQL/journal/snapshot only;
2. run the gated disposable real-Postgres catalog/FK/RLS suite;
3. rerun the narrow checks;
4. hand off full `just fast-check`, `just ci`, and `just smoke` to the root
   publication gate.

## Credit and publication

EV-SUB-W0 remains **zero credit** even after merge. Consumer nodes count only
after their separate emit + HTTP + UI + apex PRs converge and land. This branch
is local authoring only unless root separately authorizes publication.
