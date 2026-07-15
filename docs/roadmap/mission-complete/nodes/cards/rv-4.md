# rv-4 — behavior coverage edges and fail-closed affected selection

**Bucket**: runtime verification

**Phase**: MVP / Wave 2 consumer

**Base**: `origin/main` at `77553687f5ee476eaa72fd203d90449d31fbe254`

**Purpose**: make affected runtime-proof selection an explicit, persisted graph
analysis. A behavior may be omitted only when a complete edge snapshot proves it
unreachable from every changed target. Missing targets, missing behavior edges,
or broken dependency edges expand execution; they never become an implicit skip.

## Dependencies

**Hard build dependencies**

- SP-1 immutable `behavior_revisions` (`0034`) and its branded
  `BehaviorRevisionId`.
- SP-5 `behavior_coverage_edges` table + `BehaviorCoverageEdgeId` (`0037`).
- SP-8 typed append-only event vocabulary and `PgEventStore` (`0040`).
- Existing `actorCanAccessOrg` + `assertProjectAccess` authorization gates and
  the org-scoping pool mounted by `mountFeatureRoutes`.

**Downstream consumers**

- Runtime plan/gate nodes (`rv-7`, `rv-8`, `rv-12+`) consume the selected exact
  behavior-revision set; zero-result or unknown analysis is never permission to
  skip.
- Merge-queue nodes consume the persisted selection fact when explaining which
  runtime proofs an integration node requires.
- `rv-22` / `rv-23` expand the compact dashboard surface into full behavior
  history and proof views.

## Exclusive ownership

- `docs/roadmap/mission-complete/nodes/cards/rv-4.md`
- `services/orchestrator/src/engine/repositories/behaviorCoverageEdges.ts`
- `services/orchestrator/src/engine/runtimeVerification/affectedSelection.ts`
- `services/orchestrator/src/engine/runtimeVerification/affectedSelectionFacts.ts`
- `services/orchestrator/src/routes/behaviorCoverage/index.ts`
- `services/orchestrator/src/routes/behaviors/mount.ts`
- `contracts/json/events/behavior_coverage_selection_analyzed.json` (generated)
- `services/orchestrator/tests/affectedSelection.test.ts`
- `services/orchestrator/tests/behaviorCoverageEdges.test.ts`
- `services/orchestrator/tests/behaviorCoverageRoutes.test.ts`
- `services/orchestrator/tests/behaviorCoverageRls.integration.test.ts`
- `services/dashboard/src/api/behaviorCoverage.ts`
- `services/dashboard/src/api/behaviorCoverageClient.ts`
- `services/dashboard/src/components/behaviorCoverage/BehaviorCoverageBody.tsx`
- `services/dashboard/src/components/behaviorCoverage/styles.ts`
- `services/dashboard/src/routes/behaviorCoverage/index.tsx`
- `services/dashboard/tests/behaviorCoverageClient.test.ts`
- `services/dashboard/tests/behaviorCoverage.render.test.ts`

No migration, Drizzle schema, `spec_behaviors`, legacy `behaviors.metadata`, or
spine-contract edit belongs to this node. The existing `0037` table is consumed
as-is; rv-4 neither re-forks nor shadows it.

## Serialized shared-resource lease (completed and released)

The root granted and this node released a serialized lease after these minimal
registration edits were frozen:

- `services/orchestrator/src/mountFeatureRoutes.ts`
- `services/orchestrator/src/engine/events/registry.ts`
- `services/orchestrator/src/engine/events/sensitivityRules.ts`
- `services/orchestrator/src/engine/events/schemas/runtimeVerification.ts`
- `services/orchestrator/src/engine/events/schemas/graph.ts`
- `services/orchestrator/src/engine/events/sensitivityRules.runtimeVerification.ts`
- `services/orchestrator/src/engine/notifications/eventDefaultSeverity.ts`
- `services/orchestrator/src/engine/notifications/eventVocabulary.ts`
- `db/src/eventTypesSeed.ts` and the canonical event-type persistence update
- `services/dashboard/src/app/screens.ts`
- `services/dashboard/src/app/routes.ts`

The registered event is `behavior.coverage.selection_analyzed`. Its payload is
public, identifier-only proof: analysis id/version, canonical changed targets,
selected revisions + reasons, explicitly excluded revisions + edge evidence,
and unknown targets. Org/project scope and optional run/spec lineage live in the
canonical event columns, not duplicated inside the strict payload. No source
contents, credentials, provider payloads, or secret values are persisted.

The generated vocabulary mirror contains the event, but the FK-backed
`event_types` row deliberately waits for migration `0042`. IN-1 owns and must
land `0041` first; rv-4 must then rebase and exclusively own `0042` plus its
journal/snapshot update. Editing merged `0040` or racing `0041` is forbidden.

## Produces

- `BehaviorCoverageEdgesStore`:
  - records an append-only edge only for an active behavior revision in the
    requested org/project scope;
  - rejects dangling dependency targets;
  - reads one deterministic active-revision + edge graph snapshot with explicit
    `org_id` and `project_id` predicates in addition to RLS.
- `AffectedSelectionV1`:
  - exact, sorted target and behavior identities;
  - direct-edge and reverse dependency closure;
  - explicit reasons for every selected behavior;
  - an edge-backed exclusion record for every skipped behavior;
  - unknown target / uncovered behavior / dangling dependency expansion;
  - no empty-target fast-green path (empty targets select the full active set).
- HTTP:
  - `GET /orgs/:orgId/projects/:projectId/behavior-coverage`
  - `POST /orgs/:orgId/projects/:projectId/behavior-coverage/edges`
  - `POST /orgs/:orgId/projects/:projectId/behavior-coverage/affected-selection`
- Dashboard:
  - `/projects/:projectId/behavior-coverage` shows active revisions, edge counts,
    uncovered/unknown state, and an operator-triggered analysis result only
    after its durable append succeeds;
  - a strict form probe invokes the public affected-selection surface so a future
    apex can exercise the selector without a database shortcut.

## Fail-closed rules

- A changed target with no matching persisted edge selects every active behavior.
- No changed targets selects every active behavior.
- An active behavior with no edges selects itself as unknown.
- A dependency edge whose target is absent from the active snapshot selects the
  dependent behavior as unknown.
- Dependency reachability is transitive and cycle-safe.
- Every exclusion names the persisted edge ids inspected; a selector invariant
  rejects an exclusion without evidence.
- A malformed row, repository read failure, or event-fact append failure aborts
  the analysis. HTTP/dashboard surface it as unavailable; they never return or
  render a fabricated targeted result.
- Zero active behavior revisions is visibly `no_active_behaviors`, not a passing
  proof.

## Named proof and negative controls

**Gate proof**: `RV4-AFFECTED-SELECTION-FAIL-CLOSED`

- A known source target selects its directly covered behavior and every transitive
  dependent, while a fully edged unreachable behavior is excluded with edge ids.
- Mutation negative: mutate the known target ref so it no longer matches. The
  selector must expand to every active behavior; deleting an edge must select that
  uncovered behavior; dangling a dependency must select its dependent.
- Repository query assertions prove every read/write carries both org and project
  parameters and never touches `spec_behaviors` or behavior metadata.
- Real-Postgres RLS proof inserts two orgs with colliding target refs and proves
  each scoped client can read/select only its own graph; an off-scope write fails.
- Route tests prove exact auth/project binding, strict-body rejection, persisted
  fact-before-response, and append failure returning unavailable rather than an
  unpersisted selection.
- Dashboard tests prove strict response decoding, honest unavailable/empty states,
  and visible selected/excluded/unknown evidence.

## Validation

- Focused orchestrator + dashboard suites above, including the mutation negative:
  29 rv-4 unit/render proofs green on the dependency-ready subset; shared event
  registry and sensitivity-field coverage tests are also green.
- `RV4-BEHAVIOR-COVERAGE-RLS`: 4/4 tests green against real Postgres with
  `TANREN_RLS_DB_TEST=1`.
- Package typechecks, oxlint, type-aware oxlint, architecture, and event-seed
  drift checks green.
- `just affected-typecheck origin/main`
- `just affected-test origin/main`
- `just fast-check`, then `just ci` and `just smoke` after rebasing onto `0041`
  and adding `0042` plus the real `PgEventStore`/FK proof.
- Format, architecture, event vocabulary/field coverage, generated-seed drift,
  line-cap, spelling, and `git diff --check` all green.

## Serialization

The exclusive implementation can proceed in isolation. Event registration,
orchestrator route mounting, and dashboard screen/nav registration land only under
brief leases coordinated through the root; rebase after each shared owner merges.
