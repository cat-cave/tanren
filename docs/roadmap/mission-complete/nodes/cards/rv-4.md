# rv-4 — frozen behavior-coverage selection

**Bucket**: runtime verification
**Phase**: MVP / Wave 2 consumer
**State**: authoring on `mission/rv-4-final`; no node credit until merged
**Base**: `origin/main` / `98457ad02c1550aec8f24e6d965df804d160c5aa`
**Gate proof**: `RV4-AFFECTED-SELECTION-FAIL-CLOSED`

## Outcome

Make affected runtime-proof selection a durable, fail-closed graph analysis.
The authority reads the exact active behavior-revision graph, binds it to one
materialized integration node and head, stores the complete canonical fact in
the sole SP-3 CAS, and appends the frozen
`behavior.coverage.selection_analyzed` event through `PgEventStore`. The CAS
digest is the event's `analysisId`; there is no second proof store or mutable
selection row.

A behavior is excluded only when persisted coverage edges prove it unreachable.
Unknown targets, uncovered active revisions, dangling dependencies, empty
target sets, corrupt rows, stale graph/head bindings, CAS failures, and event
append failures never produce a green omission.

## Inputs, outputs, and dependencies

**Consumes**

- SP-1 immutable `behavior_revisions`, including their content digests.
- SP-3 `CasByteStore`, `Digest`, canonical JSON, and the production
  `PgCasByteStore` landed by IN-2 / #961.
- SP-5 `behavior_coverage_edges` and unified `integration_nodes` contracts.
- SP-8's already-catalogued strict W0 event
  `behavior.coverage.selection_analyzed` and the sole `PgEventStore` writer.
- Existing actor/org/project authorization and `runWithOrgScope` RLS boundary.

**Produces**

- Append-only coverage-edge recording for an active revision in the exact
  authorized org/project.
- Deterministic direct-edge plus reverse-dependency affected selection.
- Immutable CAS facts binding the selected/excluded set, inspected graph,
  integration-node identity, prepared head, tree, and member key.
- Replay verification that reports stale when any bound graph, revision,
  integration node, head, tree, or member key changes.
- Public HTTP read/write/analyze/replay surfaces and a dashboard screen showing
  graph completeness and durable selection evidence.
- Named event proof suitable for a future apex assertion.

**Downstream**

- RV-7/RV-8/RV-12+ consume the exact selected revision set.
- Merge-queue gate planning consumes the immutable selection digest.
- RV-22/RV-23 expand the compact UI into proof/history views.

## Exact active path lease

Only these paths may be edited before the serialized tail is granted:

- `docs/roadmap/mission-complete/nodes/cards/rv-4.md`
- `services/orchestrator/src/engine/repositories/behaviorCoverageEdges.ts`
- `services/orchestrator/src/engine/repositories/affectedSelectionFacts.ts`
- `services/orchestrator/src/engine/runtimeVerification/affectedSelection.ts`
- `services/orchestrator/src/engine/runtimeVerification/affectedSelectionFacts.ts`
- `services/orchestrator/src/routes/behaviorCoverage/index.ts`
- `services/orchestrator/tests/affectedSelection.test.ts`
- `services/orchestrator/tests/affectedSelectionFacts.test.ts`
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

No wildcard ownership. Amend this card before any additional exclusive path.

## Serialized tail — reserved, not currently leased

IN-1 exclusively owns migration `0043`, migration metadata, schema exports,
`main.ts`, and shared dashboard/router registration. RV-4 must not touch the
following until IN-1 lands, this branch rebases, and root explicitly grants the
lease:

- `db/migrations/0044_behavior_coverage_selection.sql`
- `db/migrations/meta/0044_snapshot.json`
- `db/migrations/meta/_journal.json`
- `services/orchestrator/src/mountFeatureRoutes.ts`
- `services/dashboard/src/app/screens.ts`

`0044` only replaces the unsafe scalar
`behavior_coverage_edges(project_id)` FK with a composite
`(org_id, project_id)` FK to IN-1's project key. It owns no event catalog row;
W0 already seeded the event in `0042`. No nav or `routes.ts` edit is required:
the dashboard is directly callable at its project-scoped URL.

## Authority and storage protocol

1. Authorize both the path org and path project before reading the graph.
2. Load a ready/landed integration node from that same org/project; server-stamp
   its head, tree, and member key rather than trusting caller-supplied values.
3. Read active behavior revisions with content digests and every project edge
   in deterministic order. Reject partial, duplicate, or cross-scope rows.
4. Select affected revisions. Empty targets and unknown impact expand; zero
   active revisions is visibly `no_active_behaviors`, never a passing proof.
5. Canonically encode the complete bound fact and put it in the sole SP-3 CAS.
6. Re-lock the graph and integration-node tables, re-read, and compare the
   exact bound input. If it changed during analysis, abort as stale.
7. Append the W0 event with the CAS digest as `analysisId` in that locked
   transaction. Return success only after the append commits.
8. Replay resolves the digest through an org/project-scoped event row, verifies
   CAS bytes and event/body agreement, then compares against the current bound
   graph and node. Any mismatch is `stale`, never reusable proof.

An event append failure may leave an inert content-addressed CAS object, but no
authoritative event and no successful response. A durable event can always
resolve the exact immutable fact after a lost HTTP response.

## HTTP and UI

All orchestrator routes are under
`/orgs/:orgId/projects/:projectId/behavior-coverage`:

- `GET /` — current bound graph plus latest durable selection, with explicit
  unavailable state on any read/decode failure.
- `POST /edges` — org-admin append of one strict coverage edge.
- `POST /affected-selection` — analyze against a server-resolved integration
  node, persist CAS then event, and return the durable fact digest.
- `GET /affected-selections/:analysisId` — exact durable fact lookup.
- `POST /affected-selections/:analysisId/verify` — fail-closed replay/freshness
  check against current graph and integration-node identity.

The dashboard route
`/projects/:projectId/behavior-coverage` renders active revisions, edge counts,
uncovered/unknown state, selected/excluded reasons, graph/head bindings, and an
operator form that invokes the real POST surface. Discovery failure is
`unavailable`, distinct from an honestly empty graph. A previously persisted
fact never renders as absent merely because current graph refresh failed.

## Proof and negative controls

- Known target selects direct coverage plus every transitive dependent; a
  fully edged unreachable revision is excluded with inspected edge IDs.
- Mutating the target to an unknown ref expands to every active revision.
- Deleting an edge selects the uncovered revision; dangling dependency input
  is rejected at write and fails closed if encountered on read.
- Mutating content digest, edge set, active revision set, node head/tree/member
  key, CAS bytes, event payload, or event scope makes replay stale/unavailable.
- Event append failure yields no 2xx and no returned selection.
- Strict request/response schemas reject selected/excluded overlap, missing
  exclusion evidence, inconsistent mode, non-canonical identities, and scope
  mismatch.
- Real Postgres proves own-org success, colliding target refs remain isolated,
  foreign-project writes fail, the `0044` composite FK is present, and the
  production HTTP → CAS → `PgEventStore` → replay path is load-bearing.
- Dashboard tests distinguish unavailable/empty/stale/current and prove the
  actual bound evidence is visible.

## Exclusions

- No edits to spine contracts, W0 registry/schema/sensitivity/severity/seed, or
  generated event JSON.
- No second digest, CAS, event writer, selection table, runtime event upsert,
  metadata fallback, or legacy `spec_behaviors` path.
- No compatibility shim, dual path, fabricated empty response, fake event
  recorder in production, or selection that is not bound to an integration
  node and exact head.
- No IN-1, IN-2, MQ-1, GV-1, or #856-owned path outside an explicit serialized
  lease.

## Validation

During exclusive authoring:

1. focused selector, CAS/event, repository, route, client, and render suites;
2. mutation-sensitive former-bug negatives;
3. `just affected-typecheck` and `just affected-test`;
4. format, architecture/line cap, event drift, and `git diff --check`.

After IN-1 and the serialized tail land:

1. disposable real-Postgres/RLS/composite-FK production-path suite;
2. rebase onto exact `origin/main` and rerun affected gates;
3. root convergence audit;
4. `just fast-check`, `just ci`, `just smoke`, hosted CI, merge, and
   post-merge reproof before rv-4 earns one node credit.
