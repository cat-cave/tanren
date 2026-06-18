# Tanren Acceptance Gates

> **Removed in P3-0001 (2026-05-28).** The direct-execution acceptance
> drivers (`just acceptance`, `acceptance-easy`, `acceptance-medium`,
> `scripts/acceptance/easy.ts`, `scripts/acceptance/medium.ts`) have been
> **deleted**. The system is now only ever exercised through the real
> dequeue→execute path: a dashboard/API-triggered run enqueues a `plan`
> job and the standalone **background run worker** service claims and
> executes it. To exercise a full run live, trigger it through the
> dashboard/API with the worker service running. The per-tier persisted-state
> **assertions** survive as
> CI dry-run smokes (`services/orchestrator/tests/phase2Acceptance{Easy,Medium}.test.ts`,
> backed by `scripts/acceptance/common.ts`). Component-level live smokes
> (`just live-codex-*`, `live-github-*`, `live-ci-poll`, `live-phase1-fixture`)
> remain. The rest of this document is retained for historical context.

---

# Phase 3 Acceptance — Hard Tier (final v0 gate)

> **P3-0026.** The final v0 acceptance gate. Where the easy/medium tiers
> proved a _clean_ run end-to-end, the **hard tier** proves the system
> survives its three hardest paths in a single run:
>
> 1. a **planner re-plan** driven by the in-loop deterministic gate
>    (P3-0005) failing a writer iteration,
> 2. an **auditor rejection loop** (`recommendedAction: loop_to_planner`)
>    routed back through the planner as rework, and
> 3. a **merge conflict** resolved through the DAG-aware intent-preserving
>    conflict resolver so the run still lands a coherent terminal state.
>
> Like everything since P3-0001, the hard tier is exercised **only through
> the real dequeue→execute path** — a triggered run enqueues a `plan` job
> and the standalone background worker service claims and executes it.
> There is **no** direct-execution script (the deleted `scripts/acceptance/*`
> are not reintroduced).

## Deterministic hard-tier gate (CI / local, no live credentials)

The deterministic proof is a real-system test that runs the **actual**
`runPlannerLoopWorkflow` through the worker's claim→execute seam
(`executeNextPlanJob`), with the adapters / gate / review / merge probes
scripted through the workflow's existing injection seams to force all
three hard paths. No real Codex, SSH, or GitHub is touched.

```sh
just acceptance-hard      # runs the deterministic hard-tier test
# or directly:
corepack pnpm exec vitest run services/orchestrator/tests/acceptanceHardTier.test.ts
```

The test
(`services/orchestrator/tests/acceptanceHardTier.test.ts`) asserts:

- The worker **claims** the queued `plan` job and runs the workflow to a
  `completed` result with loop outcome `passed`.
- **Re-plan path:** the first `per_iteration` gate call fails, so the loop
  re-plans (`planner.rerequested`, gate-producer) instead of checking a
  known-broken tree.
- **Auditor-rejection path:** the auditor rejects once (`loop_to_planner`)
  before passing — observable as ≥ 2 `pre_audit` gate calls and a third
  planner invocation.
- **Conflict-resolution path:** the approved PR's first direct merge
  reports a conflict, the intent-preserving conflict resolver fires exactly
  once, and the retried merge succeeds.
- **Coherent terminal state:** the run lands `completed` and the spec
  `merged` — not halted.
- **Bounded loops:** a companion case proves a never-converging loop
  halts as `convergence_stalled` once the loop is **provably at a fixed point**
  — the intelligent non-convergence detector observes an identical failure +
  identical work repeated, or a revisited-state cycle (A→A→A / A→B→A→B), with no
  forward progress. This is the SOLE in-loop halt (besides budget): there is **no**
  attempt cap, no `K`, and no wall-clock deadline — a loop still changing approach
  re-drives indefinitely; only a genuinely stuck one halts.

## Live fixture-hard scenario (operator, through the dashboard)

This is the real-system replacement for the deleted `just acceptance-*`
recipes: instead of a script invoking the workflow directly, the operator
**triggers a run through the dashboard** and observes the hard paths in
the run timeline as the background worker executes it.

### What a `fixture-hard` repo must contain

Create a GitHub repo `cat-cave/tanren-fixture-hard` whose single spec is
**crafted to force all three hard paths** in one run:

1. **Forces ≥ 1 native gate failure → re-plan.** The repo ships a
   `.tanren/ci.yml` whose fast tier runs the unit tests, and the task is
   phrased so a naive first writer attempt leaves the tree failing that
   tier (e.g. a function whose new test the writer is likely to break or
   leave unimplemented on the first pass). A nonzero fast-tier exit routes
   the run back to the planner via `planner.rerequested` (producer `gate`)
   **before** any checker call.
2. **Forces ≥ 1 auditor rejection → rework.** The acceptance criteria
   include a cross-cutting behavior (e.g. "the public API is documented in
   the README _and_ exported from the package index") that a per-subtask
   checker can pass while the integrated result still misses it — so the
   auditor returns `loop_to_planner` at least once.
3. **Forces a merge conflict.** The fixture's base branch carries a commit
   that touches the same lines the run's branch will edit (e.g. a
   conflicting edit to the file the task changes), so the post-approval
   direct merge reports a 409 conflict and exercises the conflict-resolver
   hook. The project must be configured with `mergeIntegration:
"direct_merge"` for Tanren to attempt the merge (otherwise it hands off
   to a human and the conflict path is not reached).

### How the operator runs it

1. Bring up the dev stack **with the standalone worker**:

   ```sh
   just up-dev
   ```

   The compose profile starts the standalone `worker` service; the
   orchestrator service keeps `TANREN_RUN_WORKER` empty so only one data
   plane dequeues `plan` jobs.

2. Create the project for `cat-cave/tanren-fixture-hard` with
   `mergeIntegration: "direct_merge"` and the hard spec text, then
   **trigger the run from the dashboard** (Spec → Run). The trigger only
   enqueues a `plan` job; the worker claims and executes it.

3. Observe the hard paths in the **run timeline** (the same events the
   deterministic test asserts):
   - `gate.failed` (fast tier, `per_iteration`) → `planner.rerequested`
     (producer `gate`) — the re-plan fired.
   - a second `planner.rerequested` (producer `auditor`) after a
     `pre_audit` gate pass — the auditor-rejection rework fired.
   - `merge.conflict` followed by a successful `merge.completed` (the
     conflict resolver resolved it) — or, if the resolver cannot resolve,
     the run halts with the conflict surfaced on the recovery surface
     (still a coherent, recoverable terminal state).
   - the run reaches `completed` and the spec `merged`.

The conflict resolver
(`engine/workflow/reviewMerge/conflictResolver/resolver.ts` +
`workspaceApplier.ts`) is a real, DAG-aware intent-preserving resolver, not a
stub — and `engine/merge/coordinator.ts` is the native merge queue that drives
it. When the resolver genuinely cannot produce a coherent merge (a true
semantic conflict a human must adjudicate), the run halts recoverably with
`merge.conflict` surfaced on the recovery surface and the operator resolves the
conflict on the PR. That is the intended escalation, not a placeholder.
