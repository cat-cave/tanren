# rv-4 — behavior coverage edges and fail-closed affected selection

**Bucket**: runtime verification

**Phase**: MVP / Wave 2 consumer — **not complete**

**State / audit verdict**: strict mission-complete node count for rv-4 remains
**zero**. The code retained on this branch is **preparation**, not a landed node.
The post-audit verdict is **`REPAIR-BEFORE-RESTACK`** — it is neither completion
nor PR readiness. The selector core, repository, route shells, dashboard client,
event-vocabulary mirror, and focused suites compile and run on the
dependency-ready subset, but the durable migration, the composite-FK proof, the
frozen-graph binding, the production-path proof, the convergence audit, and the
merge/reproof are all still owed. Nothing on this branch is merged or
merge-ready; no current green suite is a durable, replayable, authoritative gate
fact.

**Base**: preparation sits at `9d9b902` (`feat(runtime): add fail-closed behavior
coverage selection`) atop `origin/main` `9f20c3ea` (#943). The prior `77553687`
base recorded in earlier drafts is stale. An **exact-current-`main` convergence
audit** is required before restack — `main` will have moved again once #856, IN1
`0041`, and their queue clear.

**Purpose**: make affected runtime-proof selection an explicit, persisted graph
analysis. A behavior may be omitted only when a complete edge snapshot proves it
unreachable from every changed target. Missing targets, missing behavior edges,
or broken dependency edges expand execution; they never become an implicit skip.

## Landing order (exact dependency chain)

rv-4 cannot restack or merge until each upstream barrier clears, in order:

1. **#856** — `fix(dashboard): surface BFF failure states` (OPEN,
   `codex/dashboard-loud-bff-errors`). Establishes the dashboard BFF
   failure-state contract rv-4's clients must be rederived against.
2. **IN1 `0041`** — integration lifecycle. Owns the `(org_id, project_id)`
   unique key rv-4's composite FK must reference.
3. **RV4 `0042`** — this node's migration (see §Migration `0042` requirements).

Downstream train then continues, each owning its next free migration slot:
**GV1 `0043`**, **GV2 `0044`**, **MQ1 `0045`**, **GV3 `0046`**. Editing merged
`0040`/`0041` or racing any of these slots is forbidden.

## Dependencies

**Hard build dependencies**

- SP-1 immutable `behavior_revisions` (`0034`) and its branded
  `BehaviorRevisionId`.
- SP-5 `behavior_coverage_edges` table + `BehaviorCoverageEdgeId` (`0037`).
- SP-8 typed append-only event vocabulary and `PgEventStore` (`0040`).
- IN1 `0041` integration-lifecycle unique key `(org_id, project_id)` — the
  referenced side of rv-4's composite project FK.
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
spine-contract edit belongs to this node's preparation. The existing `0037`
table is consumed as-is; rv-4 neither re-forks nor shadows it. `0042` is the
first migration rv-4 owns, and only after IN1 lands `0041`.

## Serialized shared-resource lease (NOT landed — recreated at restack)

The shared registration edits below exist on this branch as a **frozen
baseline**, but they are **not landed and not merge-ready**. They must be
**recreated from the then-current `main` under serialized leases** when rv-4
restacks after #856 and `0041` — never replayed blindly from this snapshot,
because `main`, the registry, `screens.ts`/nav, and `mountFeatureRoutes` will
all have moved:

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
`event_types` row deliberately waits for migration `0042` (the seeded
`eventTypesSeed.ts` mirror and the generated seed in `0040` are not the FK
gate). IN-1 owns and must land `0041` first; rv-4 must then rebase onto
then-current `main` and exclusively own `0042` plus its journal/snapshot update.

## Migration `0042` requirements (owed)

`0042` is owned exclusively by rv-4 and must, at minimum:

1. **Seed/register the exact event vocabulary** — persist the canonical
   `event_types` row for `behavior.coverage.selection_analyzed` (and any
   retained-historical mirror) in-transaction before the referencing FKs are
   enforced, mirroring `db/src/eventTypesSeed.ts`.
2. **Replace the unsafe scalar project FK with a composite
   `(org_id, project_id)` FK** using IN1 `0041`'s unique key. The current
   `0037` `behavior_coverage_edges_project_fk FOREIGN KEY (project_id)
REFERENCES projects(project_id)` is a scalar FK that does not bind `org_id`
   and cannot prevent a cross-tenant join if application code errs (runtime.md
   §3 tenancy rule). `0042` must drop/replace it with a composite
   `(org_id, project_id)` reference to IN1's unique key, and apply the same
   repair to any rv-4-owned table carrying the scalar project FK.
3. **Real PG/RLS proof** — the RLS integration suite must run against the `0042`
   schema (composite FK) and demonstrate both **own-org success** and
   **foreign-project rejection** (an off-scope project_id under the same or a
   different org must fail the composite FK / RLS `WITH CHECK`, not return
   foreign facts).

The current `behaviorCoverageRls.integration.test.ts` runs against the `0037`
scalar-FK schema; it is preparation evidence only and is **not** the composite-FK
foreign-project-rejection proof `0042` owes.

## Produces (target spec — not all landed)

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

**Gate proof**: `RV4-AFFECTED-SELECTION-FAIL-CLOSED` (design; not yet a durable
gate fact).

- A known source target selects its directly covered behavior and every
  transitive dependent, while a fully edged unreachable behavior is excluded
  with edge ids.
- Mutation negative: mutate the known target ref so it no longer matches. The
  selector must expand to every active behavior; deleting an edge must select
  that uncovered behavior; dangling a dependency must select its dependent.
- Repository query assertions prove every read/write carries both org and
  project parameters and never touches `spec_behaviors` or behavior metadata.
- Real-Postgres RLS proof (post-`0042`, composite FK) inserts two orgs with
  colliding target refs and proves each scoped client can read/select only its
  own graph; an off-scope write fails; a foreign-project write is rejected by
  the composite FK.
- Route tests prove exact auth/project binding, strict-body rejection, persisted
  fact-before-response, and append failure returning unavailable rather than an
  unpersisted selection.
- Dashboard tests prove strict response decoding, honest unavailable/empty
  states, and visible selected/excluded/unknown evidence.

**Affected-selection binding (owed — not yet implemented).** The current
`selectAffectedBehaviorRevisions` core is a pure in-memory selector over an
injected `BehaviorCoverageSnapshot`; the snapshot carries `orgId`/`projectId`/
`behaviors` but **no frozen graph identity**. Before this node counts as done,
the affected-selection proof must:

- bind the selected set to a **frozen graph generation/digest** (or equivalent
  serialized, content-addressed snapshot of the active revisions + edges
  inspected), plus the **exact integration node** and **head identity** the
  selection was computed against;
- prove a **concurrency negative**: if the underlying graph or any inspected
  revision changes between selection and replay, the proof must fail closed — it
  must never produce an **unreplayable** or **falsely fresh** result (a stale
  selection cannot be presented as authoritative for a head/graph it was not
  computed against).

## Post-#856 client/UI rederive (owed)

Once #856 lands the dashboard BFF failure-state contract, rv-4's clients and UI
must be **rederived** against it. The preparation code on this branch predates
#856 and must be corrected, not assumed compatible:

- rederive the **exact-status / schema clients** (`behaviorCoverageClient.ts`,
  orchestrator route response shapes) against the post-#856 contract;
- failed discovery / snapshot reads **cannot render not-found / empty** — they
  must surface an explicit unavailable state;
- a **persisted selection cannot vanish** on a follow-up read failure — the
  durably-appended fact remains the source of truth and the UI must show it as
  unavailable-to-refresh, not absent;
- response schemas need **cross-field invariants** (e.g. selected ∩ excluded =
  ∅; every exclusion's `inspectedEdgeIds` non-empty and resolvable in the bound
  snapshot; `mode` consistent with the selected/excluded/unknown vectors);
- **route-injected snapshots must bind to the authorized path scope** — a
  selection computed from a request-injected or cached snapshot must carry the
  authorized `orgId`/`projectId`/integration-node/head binding and reject any
  mismatch rather than silently adopting an unverified graph.

## Validation

**Preparation evidence (current operator probes — NOT durable gate facts).** The
current green suites prove the preparation compiles and the in-memory selector
holds on the dependency-ready subset; they do **not** exercise the real
`0042` composite-FK schema, the frozen-graph binding, or the production path:

- focused orchestrator + dashboard suites, including the mutation negative: the
  rv-4 unit/render proofs are green on the dependency-ready subset; shared event
  registry and sensitivity-field coverage tests are also green;
- `RV4-BEHAVIOR-COVERAGE-RLS`: 4/4 tests green against real Postgres with
  `TANREN_RLS_DB_TEST=1`, **against the `0037` scalar-FK schema** — this is
  preparation evidence, not the composite-FK foreign-project-rejection proof;
- package typechecks, oxlint, type-aware oxlint, architecture, and event-seed
  drift checks green on the prepared subset.

**Still required before this node counts as done (owed):**

- real **production-path PostgreSQL / auth / RLS / HTTP / `PgEventStore`** proof
  against the `0042` composite-FK schema, including own-org success and
  foreign-project rejection;
- **former-bug negatives** and the **affected checks** above (frozen-graph
  binding + concurrency negative, post-#856 client/UI rederive with
  cross-field invariants and path-scoped snapshots);
- `just affected-typecheck origin/main` and `just affected-test origin/main`
  re-run after rebasing onto `0041`;
- `just fast-check`, then `just ci` and `just smoke` after rebasing onto `0041`
  and adding `0042` plus the real `PgEventStore`/composite-FK proof;
- **exact-current-`main` convergence audit** — re-derive the base, re-create the
  shared registry/nav/mount edits under serialized leases, and confirm no stale
  ordinal or foreign-file replay;
- **hosted CI** green, **merge**, and **post-merge reproof** against the live
  production path.

Until the owed items are satisfied, the verdict stays
`REPAIR-BEFORE-RESTACK`; the node is not complete and no PR is opened.

## Serialization

The exclusive implementation can proceed in isolation. Event registration,
orchestrator route mounting, and dashboard screen/nav registration land only
under brief leases coordinated through the root, **recreated from then-current
`main`** at restack time — never replayed blindly from this branch's frozen
baseline. Rebase after each shared owner (#856, IN1 `0041`) merges.
