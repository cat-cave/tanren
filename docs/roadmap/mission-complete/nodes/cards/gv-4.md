# gv-4 — transitive stack retarget safety repair

**Phase**: MVP safety repair (governance Phase 0)  
**State at admission**: defect live on `main` — `resolveSpeculativeState` loads
only direct `depends_on`, so `mergedSpecIds` is incomplete against the full
`ancestor_stack` member vector  
**Purpose**: retarget stacked-PR bases from the complete persisted ancestor
member vector (the sole jj-local base authority), never from direct-only
`depends_on`. Depth-6 chains and diamond/fan-in must drop every merged
transitive ancestor and land on `default_branch` when the stack empties.

## Dependencies

**Hard build dependencies**

- `runs.ancestor_stack` as the sole base source (`ancestorStack.ts`,
  walker-jj-local-integration-design §2.3 / §3.2–§3.3).
- Existing merge-stage walk: `resolveSpeculativeState` →
  `applySpeculativeRetarget` → `resolveStackRetarget` → `merge.retargeted`.
- Existing event `merge.retargeted` (already seeded — no registry/seed edit).

**Downstream consumers**

- Merge dispatcher speculative hold + stack walk (`mergeDispatch.ts` — read-only
  consumer; not owned).
- Base-shift coordinator already re-resolves stacks independently; this node only
  repairs the merge-stage retarget membership set.

## Exclusive ownership

- `docs/roadmap/mission-complete/nodes/cards/gv-4.md`
- `services/orchestrator/src/engine/workflow/reviewMerge/speculativeStackRetarget.ts`
- `services/orchestrator/src/routes/runs/stackRetargetRoute.ts`
- `services/orchestrator/src/routes/runs/stackRetargetContract.ts`
- `services/orchestrator/tests/reviewMergeStackedRetarget.test.ts`
- `services/orchestrator/tests/stackRetargetRoute.test.ts`
- `services/dashboard/src/api/stackRetarget.ts`
- `services/dashboard/src/components/runDetail/StackRetargetPanel.tsx`
- `services/dashboard/tests/stackRetarget.render.test.ts`

## Shared-resource leases (minimal wire only)

Serialize concurrent edits and request a root lease before expanding beyond a
one-line / thin wire:

- `services/orchestrator/src/routes/runs/index.ts` — one
  `registerStackRetargetRoute(...)` registration only (no body rewrites).
- `services/dashboard/src/routes/runs/index.tsx` — fetch + pass stack-retarget
  props into `RunDetailBody` only.
- `services/dashboard/src/components/runDetail/RunDetailBody.tsx` — render
  `<StackRetargetPanel />` only.
- `services/orchestrator/tests/reviewMerge.fixtures.ts` — filter merged-spec
  mock rows by the SQL `ANY($2)` candidate set so direct-only incompleteness is
  observable (shared fixture; keep change minimal).
- `services/orchestrator/tests/reviewMergeP2c.test.ts` — align one hold fixture
  so the unmerged ancestor is on the stack (complete member vector), not only
  on `depends_on`.

**Do not touch (active foreign leases / out of scope)**

- `mountFeatureRoutes.ts`, `MergeQueueBody.tsx`, mq-1 event registry/seed paths
- migration `0041` / integration lifecycle / rv-4 / #856 paths
- event registry, sensitivity rules, `eventTypesSeed`, new event types
- `mergeDispatch.ts` body (call site already correct)

No migration. No parallel stack resolver. No second base authority.

## Consumes

- `resolveAncestorStack` / `AncestorStack` (sole VCS base column).
- Existing genuinely-merged SQL (status `merged` ∧ no unresolved
  `merge.speculative_held`).
- `resolveStackRetarget` / `applySpeculativeRetarget` (unchanged walk math).
- Event `merge.retargeted` as the named live proof.
- Run/project authz: `actorCanAccessOrg` + `assertProjectAccess` + run
  project/org bind (same pattern as run detail).

## Produces

### Engine

- `resolveSpeculativeState` membership = **all** `ancestor_stack[].specId`
  values (transitive member vector). Direct `depends_on` is not consulted.
- `mergedSpecIds` / `unmergedAncestors` are complete against that vector.
- When every stack member is genuinely merged → `toBase = default_branch` and
  remaining stack `[]`.

### Named event proof

- Production merge path emits `merge.retargeted` with correct `fromBase` /
  `toBase` when the walk moves the base (including transitive-ancestor drops
  that land on `default_branch`).

### HTTP

`GET /orgs/:orgId/projects/:projectId/runs/:runId/stack-retarget`

- `200 StackRetargetView` — resolved stack, merged/unmerged sets, walk target
  (`toBase`), remaining stack, default branch, `missionNodeId: "gv-4"`.
- `403` org or project access denied.
- `404` run missing / wrong project / wrong org (no metadata leak).
- Non-speculative run (empty stack) returns a definitive non-speculative view
  (`speculative: false`, empty members, `toBase = defaultBranch`).

### UI

`StackRetargetPanel` on run detail:

- Lists ordered ancestor members with merged vs unmerged.
- Shows walk target base and whether the stack is empty / holds.
- Never paints merged transitive ancestors as the live base target when they
  are in `mergedSpecIds`.
- Absent / non-speculative state is explicit, not green-success cosplay.

## Behavior proof

Positive:

1. **Depth-6 chain** — `ancestor_stack` length 6; only direct parent in
   `depends_on` (stale fixture of the defect); five transitive ancestors already
   merged → production `mergeForRun` retargets past them; when all six merge →
   `toBase = default_branch`, stack write `[]`, `merge.retargeted` fires.
2. **Diamond / fan-in** — multi-parent stack; merged parents drop; unmerged
   peer remains the walk target; hold retained until peers merge.
3. **Idempotent no-op** — live base already equals walk target and no drop →
   no `retargetBase`, no `merge.retargeted`, no stack write.

Negative / mutation:

4. **Direct-only incompleteness must fail** — if membership were still the
   direct `depends_on` set while the stack still carries merged transitive
   ancestors, remaining stack would keep those ancestors and `toBase` would not
   be `default_branch` after the direct parent merges. Focused tests pin the
   complete-vector path so that regression fails the suite.

## Validation

- Focused: `reviewMergeStackedRetarget.test.ts`, `stackRetargetRoute.test.ts`,
  `stackRetarget.render.test.ts`.
- Affected typecheck/test on orchestrator + dashboard.
- Line counts under 500; no migration; format/lint/architecture on owned files.

## Serialization

Do not expand shared wires (`runs/index.ts`, `RunDetailBody.tsx`, run detail
route, reviewMerge fixtures) beyond the listed thin seams without a root lease.
