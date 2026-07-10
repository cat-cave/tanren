# Walker / percolation → jj-local integration (retire the synthesized `tanren/integ` ref)

> Status: **IMPLEMENTED — the WS-A build + WS-B deletions landed.** The dependent run
> jj-assembles its base from the real ancestor PR-head refs (`runs.ancestor_stack`);
> there is no orchestrator-synthesized `tanren/integ` ref, `PgSpeculativeIntegrator`
> is deleted, and the `WALKER_JJ_LOCAL_BASE` flag is removed (the path is
> unconditional). Companion to `docs/architecture/tanren-owns-the-engine.md` (§3
> unified run + `integration_nodes`, §6 minimal `CodeHost`, §7 deletions). This doc
> was the concrete plan for the §8 item "the walker/percolation
> `speculativeIntegrator` → jj-local cutover" — now complete.

## 0. The decision this design implements

The dependent run must materialize its base by **jj-assembling the REAL ancestor PR-head
refs that already exist on the host** — there is **NO orchestrator-synthesized
`tanren/integ/<dep>` integration ref at all**. Both the "push a synthesized transport ref"
half-measure (Option A) and "defer" (Option C) are rejected. This is the jj-native
end-state: the host holds only the things a human would push (per-spec PR head branches +
`main`); the prospective merged world is assembled **locally on the dependent's runner**,
exactly as the batch gate already does.

## 1. Why a synthesized ref existed, and why it was removed

### 1.1 Pre-cutover server-side path (deleted)

When the walker decided a dependent `B` was ready speculatively, `enqueueOne`
(`engine/dag/walker.ts:287`) called `integrator.buildIntegration(...)`, which resolved to
`PgSpeculativeIntegrator.buildIntegration` (`engine/dag/speculativeIntegrator.ts:59`). That
drove `VcsProvider.buildIntegrationBranch` (`speculativeIntegrator.ts:99` →
`githubVcsProvider.ts:342`) to assemble a **server-side host ref** `tanren/integ/<dep>`
(`speculativeIntegrator.ts:29-34`) = `default_branch + each unmerged ancestor branch`
merged in DAG order via the GitHub `/merges` API (409-prone). The walker then persisted that
ref name as the dependent run's single `runs.speculative_base`
(`walker.ts:310`, schema `db/migrations/0000_collapsed_baseline.sql:469`).

The dependent run — a **separate runner allocation** — consumed it as a host-fetchable
branch:

- `engine/worker/runExecutionContext.ts:173` — `targetBranch = speculative_base ?? default_branch`.
- `engine/workflow/plannerRunWorkspace.ts:197,291-311` — `git clone --depth 1 --branch <targetBranch>`
  from the **remote host** (it had to be a real remote branch).
- `engine/workflow/plannerRunAdapters.ts:262-265` — the merge-time rebase base
  `baseRevision = ${targetBranch}@origin` (a remote-tracking bookmark).
- `engine/workflow/githubDraftPr.ts:141,211` — the draft PR's `baseBranch`.
- `engine/dag/baseShiftLiveSeams.ts:89,103` — even the never-discard base-shift rebase
  resolved `newBaseSha = ${newBaseRef}@origin`, i.e. it re-cloned the integration ref as a
  remote bookmark.

So **the only reason a synthesized host ref existed was that the dependent's runner fetched
its base via `git clone --branch <single-ref>`** — a single fetchable ref. That was the
exact assumption we broke.

### 1.2 The batch path already proves the jj-native pattern

`withJjLocalIntegration` (`engine/dag/jjLocalIntegration.ts:83`) over
`buildLiveJjWorkspace` (`engine/providers/liveJjWorkspace.ts:123`) opens ONE live jj
workspace, fetches the base + every member bookmark as `<branch>@origin` (the clone's
`--colocate` fetch), `rebaseOnto`-stacks the ordered members locally
(`jjLocalIntegration.ts:127-154`), and materializes `headSha`/`treeHash` with **NO host
ref written** (`jjLocalIntegration.ts:17-19`). The batch path runs the gate on THAT open
workspace (`merge/batchIntegrationNodeDrive.ts:134`) and releases — it never hands off to a
new runner, which is why it never needed a fetchable ref.

The ideal architecture **generalizes this assembly to the dependent's own
workspace-bootstrap step**: the dependent's runner is already where the clone happens
(`plannerRunWorkspace.ts:188-201`, over `input.ssh` against the run's `target`), so we
replace its single-ref clone with a multi-ref jj assembly over that same runner — before
the writer's first commit.

## 2. The ideal target architecture

### 2.1 The dependent run bootstraps its own base by jj-assembling real ancestor refs

Replace `cloneWorkspace` (`plannerRunWorkspace.ts:188`) / `buildCloneCommand`
(`plannerRunWorkspace.ts:291`) with a **jj multi-ref assembly** when the run carries an
ancestor stack:

1. **Resolve the stack.** The run row carries the ordered unmerged-ancestor PR-head
   branches (new `ancestor_stack` shape, §2.3) — each is a REAL pushed branch on the host
   (every ancestor `runs.branch` is the PR head `draftPrBranchName` produced; resolved
   today by `PgSpeculativeIntegrator.loadAncestorBranches`, `speculativeIntegrator.ts:131`,
   which moves into a pure stack-resolver helper).
2. **Assemble locally.** Open a live jj workspace on the dependent's runner (the SAME
   `buildLiveJjWorkspace` thread; the runner is already allocated for the run), `jj git
clone --colocate` so jj fetches `main@origin` + each `ancestorBranch@origin`, then stack
   them in DAG order via `core.rebaseOnto` — i.e. **reuse the exact loop in
   `integrateOverWorkspace`** (`jjLocalIntegration.ts:112-161`). The result: a local
   integration bookmark whose head is `main + ordered ancestors`, materialized
   `headSha`/`treeHash`, with **no host ref**.
3. **The writer starts on the assembled head.** The dependent's run branch
   (`runs.branch`) is created at that local integration head (`core.branch`), and the
   writer commits onto it. The dependent's PR head therefore already contains the ancestor
   stack as its history prefix — exactly what a human stacking PRs would have.
4. **A spec-vs-spec conflict during assembly** surfaces the SAME `conflict` outcome the
   server build returned (`jjLocalIntegration.ts:142-152`) and the walker HOLDS the
   dependent (§2c, `walker.ts:292-305`), routing the ancestor pair to the resolver — no
   change to that control flow.

This reuses `withJjLocalIntegration` / `buildLiveJjWorkspace` / jj `rebaseOnto` wholesale.
The ONE new piece is a **bootstrap variant** of `withJjLocalIntegration` whose
continuation, instead of "run the gate then release", is "create the run branch at the
integrated head, hand the open workspace to the writer loop, release at run end" — i.e. the
workspace is the run's workspace, not a throwaway gate workspace.

### 2.2 The never-discard `BaseShiftCoordinator` already fits — it stops re-cloning a synthesized ref

On a base shift (an ancestor lands / advances), the `BaseShiftCoordinator`
(`engine/dag/baseShiftCoordinator.ts:173`) already **jj-rebases the dependent's existing
branch in place** (`rebaseOnto`, `baseShiftCoordinator.ts:246`) — it never re-clones a
synthesized integration ref into the dependent's history; it just changes what the branch
is rebased ONTO. The ONLY coupling to the synthesized ref is the live opener resolving
`newBaseSha = ${newBaseRef}@origin` (`baseShiftLiveSeams.ts:103`) and `keepRun`
re-pointing `speculative_base = newBaseRef` (`baseShiftCoordinator.ts:408`).

Under the new model the "shifted base" is no longer a single synthesized ref; it is the
**re-resolved ancestor stack** (some ancestors merged → dropped; the rest at their new
heads). The base-shift opener assembles that stack locally (the §2.1 assembly) and rebases
the dependent's branch onto the assembled head — `rebaseOnto(branch, assembledHead)`. So the
coordinator's logic is unchanged; only its `newBaseRef: string` input becomes a
`newBaseStack: AncestorStack` and `open(...)` does a local multi-ref assembly instead of a
single-ref clone. The never-discard / re-gate / replan / fail-closed-HOLD behavior
(`baseShiftCoordinator.ts:252-371`) is untouched.

### 2.3 `runs.speculative_base` (single ref) → an ancestor stack

`runs.speculative_base text` (`0000_collapsed_baseline.sql:469`) cannot name N ancestors.
Replace its semantics:

- **New column `runs.ancestor_stack jsonb`** — the ordered list of unmerged ancestors the
  run is stacked on: `[{ specId, runId, branch, headSha }]` (the same shape as
  `IntegrationNodeMember`, `contracts/integrationNodes.ts:41`). `headSha` is the ancestor
  PR-head sha captured at assembly time (the divergence key — it REPLACES the parallel
  `runs.integrated_ancestor_shas jsonb`, `0000_collapsed_baseline.sql:470`, folding two
  columns into one ordered structure).
- **`speculative_base` is dropped** once the stack column is the source of truth. A run is
  "speculative" iff `ancestor_stack` is non-empty (replaces the `speculative_base IS NOT
NULL` predicate in `resolveSpeculativeState`, `mergeDispatch.ts:257`, and
  `runExecutionContext.ts:173`).
- **`integration_nodes` reference the ancestor refs, not a synthesized ref.** The
  `integration_nodes.ref text` column (`0007_integration_nodes.sql`, "the ephemeral git ref
  the node materializes as", `contracts/integrationNodes.ts:53`) becomes the **local**
  assembly bookmark name (already true for the batch path's `batchLocalIntegrationRef`,
  `batchIntegrationNodeDrive.ts:40`); the host-meaningful identity is the
  `members[].branch` + `members[].headSha` it already carries
  (`contracts/integrationNodes.ts:41`). No schema change to `integration_nodes` members;
  the eager/dependent node is UPSERT-ed from the same assembly the run bootstrap performs
  (`purpose: 'eager_base'`, already a valid value, `0007_integration_nodes.sql` CHECK).

### 2.4 N-ancestor / diamond case

The stack is **DAG-ordered** (ancestors before dependents; the walker already passes
`unmergedAncestors` in DAG order, `walker.ts:290`). For a diamond `A → {B,C} → D`, `D`'s
`ancestor_stack` is the topologically-ordered `[A, B, C]` (A first; B,C in any stable order the DAG
sort fixes — order is load-bearing for the assembly + the `memberKey`,
`contracts/integrationNodes.ts:88`). jj `rebaseOnto` stacks them transitively; a B-vs-C
conflict surfaces as the §2.1 conflict outcome and `D` is held until the pair reconciles
(unchanged from today's `conflictBetween` routing). There is no "merge ref" object — the
stack IS the integration.

## 3. The stacked-PR projection

### 3.1 Base model

`B`'s draft PR base = **its immediate-ancestor PR head branch**, not a synthesized ref:

- `openDraftPullRequest({ baseBranch })` (`githubDraftPr.ts:137-144`) uses
  `baseBranch = the LAST entry of ancestor_stack` (the immediate ancestor's PR-head
  branch). GitHub then renders the PR showing only `B`'s delta over its ancestor — a true
  stacked PR.
- This requires the immediate ancestor's PR-head branch to exist on the host: it does — it
  is the ancestor run's `runs.branch`, pushed when the ancestor opened its own draft PR
  (`githubDraftPr.ts:131-135`).

### 3.2 Retarget on ancestor merge

When the immediate ancestor merges, retarget `B`'s PR base to the **next** still-unmerged
ancestor in the stack (or to `default_branch` when the stack empties), via the existing
`retargetPullRequestBase` (`providers/githubPullRequestReuse.ts`, surfaced through
`probe.retargetBase`, `mergeDispatch.ts:150`). The current code already retargets `integ →
default_branch` on hold-clear (`mergeDispatch.ts:141-160`); the new code retargets
`<merged-ancestor-branch> → <next-ancestor-branch | default_branch>` and updates
`runs.ancestor_stack` (drop the merged head). The `merge.retargeted` event
(`events/registry.ts:318`) carries the new base; the `merge.speculative_held` /
`resolveSpeculativeState` hold (`mergeDispatch.ts:108-140`) still gates the MERGE until all
ancestors land (no unreviewed ancestor code reaches `main` early), unchanged.

### 3.3 N-ancestor / diamond retarget

The PR base is always the **single immediate ancestor** (the last stack entry); the deeper
ancestors are visible transitively through that ancestor's own stacked PR. On each ancestor
merge, retarget walks ONE step down the stack. For a diamond, `D`'s base retargets `C → B →
A → main` (or whatever topological order the stack fixed) as each lands — each step is a single
`retargetPullRequestBase` call. No "merge ref" is ever created or cleaned up, so the
`cleanupIntegrationBranch` dance (`mergeDispatcher.ts:222`, `mergeLandPaths.ts:116,235`)
disappears (§4, §5).

> **FORK F1 (flagged, §6):** PR-base = _immediate ancestor_ (true incremental stacked PR,
> minimal diff) vs PR-base = _the local assembled head pushed as the dependent's own branch
> base_. Recommendation: immediate-ancestor (§3.1) — it is the human-stacked-PR model, needs
> no synthesized ref, and is what `retargetPullRequestBase` already expresses.

## 4. Call-site impact

| File:line                                                                      | Today                                                 | Becomes                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/dag/walker.ts:287`                                                     | `integrator.buildIntegration(...)` → synthesized ref  | resolve the ordered ancestor stack (pure helper); NO host build. Conflict pre-check (§4a) still possible via a dry assembly or deferred to bootstrap.             |
| `engine/dag/walker.ts:310`                                                     | `speculativeBase: integration.integrationBranch`      | `ancestorStack: [...]` persisted on the run; no `speculative_base`.                                                                                               |
| `engine/dag/percolationOperation.ts:96`                                        | `integrator.buildIntegration(...)` to rebuild the ref | re-resolve the unmerged ancestor stack (drop merged) → hand to `BaseShiftCoordinator` as `newBaseStack`.                                                          |
| `engine/worker/runExecutionContext.ts:173`                                     | `targetBranch = speculative_base ?? default_branch`   | `targetBranch = default_branch`; the ancestor stack is threaded separately to the bootstrap assembler.                                                            |
| `engine/workflow/plannerRunWorkspace.ts:197,291`                               | `git clone --branch <targetBranch>`                   | jj multi-ref assembly (`buildLiveJjWorkspace` + the `integrateOverWorkspace` stack loop) when `ancestor_stack` non-empty; plain `default_branch` clone otherwise. |
| `engine/workflow/plannerRunAdapters.ts:262-265`                                | `baseRevision = ${targetBranch}@origin` (single ref)  | the merge-time rebase base = the locally re-assembled stack head (or `default_branch@origin` once ancestors merged).                                              |
| `engine/workflow/githubDraftPr.ts:141,211`                                     | `baseBranch = speculative_base ?? default_branch`     | `baseBranch = immediate-ancestor PR-head branch` (last stack entry) ?? `default_branch`.                                                                          |
| `engine/dag/baseShiftLiveSeams.ts:89,103`                                      | `newBaseSha = ${newBaseRef}@origin`                   | local multi-ref assembly of the re-resolved stack → rebase onto the assembled head.                                                                               |
| `engine/dag/baseShiftCoordinator.ts:408` (`keepRun`)                           | `speculativeBase = newBaseRef`                        | `ancestorStack = re-resolved stack` (or empty when all merged).                                                                                                   |
| `engine/workflow/reviewMerge/mergeDispatch.ts:248` (`resolveSpeculativeState`) | reads `speculative_base` single ref                   | reads `ancestor_stack`; "speculative" iff non-empty; retarget walks one step.                                                                                     |

**§4a — the speculative ancestor-vs-ancestor pre-check.** Today the conflict is detected at
walker time (the server build returns `conflict`, `walker.ts:292`). Under the new model the
assembly happens at the dependent's _bootstrap_, not at walk time. Two options
(**FORK F2, §6**): (i) the walker enqueues optimistically and a bootstrap-time assembly
conflict marks the run held + routes the pair (slightly later detection, one fewer host
round-trip); (ii) the walker runs a cheap dry assembly to pre-check before enqueue
(preserves walk-time detection, costs a runner). Recommendation: (i) — the conflict still
surfaces before the dependent does any work (the writer hasn't started), and it removes a
synchronous host build from the walk tick.

## 5. What gets deleted (the §7 deletions this unblocks)

Mapped to the PR that removes it (all in **WS-B**, AFTER the WS-A assembly path is live and
proven):

| Deleted                                                                                                        | Files                                                                                                                                     | PR                                                                                      |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `SpeculativeIntegrator` contract                                                                               | `engine/contracts/speculativeIntegrator.ts`                                                                                               | WS-B/PR-9                                                                               |
| `PgSpeculativeIntegrator` + `integrationBranchName` (`tanren/integ/*`)                                         | `engine/dag/speculativeIntegrator.ts`                                                                                                     | WS-B/PR-9                                                                               |
| Walker/percolation `integrator` deps + wiring                                                                  | `engine/dag/walker.ts`, `percolationOperation.ts`, `percolationBuild.ts:304-310`, `subscriber.ts:47-51,121`, `worker/autonomyLoops.ts:91` | WS-B/PR-9                                                                               |
| `VcsProvider.buildIntegrationBranch` + the `/merges` ref dance                                                 | `engine/contracts/vcsProvider.ts:139`, `providers/githubVcsProvider.ts:342`, `providers/buildVcsProvider.ts:162`                          | WS-B/PR-10                                                                              |
| The batch path's server-side `buildIntegrationBranch` fallback                                                 | `engine/merge/batchChecker.ts:155,174-188`                                                                                                | WS-B/PR-10 (after `INTEGRATION_NODES_DRIVE` is unconditional)                           |
| `cleanupIntegrationBranch` (no ephemeral ref to clean)                                                         | `engine/workflow/reviewMerge/mergeDispatcher.ts:222`, `mergeLandPaths.ts:78,116,235`                                                      | WS-B/PR-11                                                                              |
| `resolveSpeculativeState` single-ref semantics + `speculative_base` column + `integrated_ancestor_shas` column | `mergeDispatch.ts:248`, schema `runs` (`0000_collapsed_baseline.sql:469-470`)                                                             | WS-B/PR-12 (migration LAST)                                                             |
| `tanren/integ` event-payload fields                                                                            | `engine/events/schemas/integrations.ts:166,173`, `sensitivityRules.infra.ts:336-338`                                                      | WS-B/PR-11                                                                              |
| Conformance: `speculativeIntegrator.conformance.test.ts`, `dagSpeculativeIntegratorPg.test.ts`                 | `tests/conformance/speculativeIntegrator.conformance.test.ts`, `tests/dagSpeculativeIntegratorPg.test.ts`                                 | WS-B/PR-9 (replaced by an ancestor-stack-assembly conformance suite added in WS-A/PR-3) |

Per §7's "If the refactor doesn't net-delete code, it's wrong" — this nets a deletion (the
whole `SpeculativeIntegrator` seam + a `VcsProvider` method + a 409-handling dance + two
columns).

## 6. Remaining genuine forks (flagged, not silently chosen)

- **F1 — stacked-PR base target.** Immediate-ancestor branch (§3.1, **recommended**) vs a
  pushed assembled-head branch. Immediate-ancestor is the human-stacked model, needs no
  synthesized ref, and reuses `retargetPullRequestBase`.
- **F2 — where the ancestor-vs-ancestor conflict is detected.** Bootstrap-time
  (**recommended** — no host build on the walk tick; still before the writer runs) vs a
  walk-time dry assembly (preserves exact current timing, costs a runner per pre-check).
- **F3 — the dependent's PR history.** Stacking the ancestors as real commits in the
  dependent's branch (the §2.1 default — the PR diff vs its ancestor base shows only B's
  delta) vs assembling them into a single squashed base commit. Recommendation: real
  commits (jj-native, and the stacked-PR base render already hides them from B's diff). A
  squash would re-introduce a synthesized object. **Open for review** — this is the one
  with a genuine product-visible difference (what reviewers see in the PR), so I am not
  hard-choosing it.
- **F4 — `integration_nodes.purpose` for the eager dependent node.** Reuse `eager_base`
  (exists, `0007_integration_nodes.sql` CHECK) vs a new `dependent_stack` value.
  Recommendation: reuse `eager_base` (no migration; the label never branches control flow,
  `contracts/integrationNodes.ts:54`).

## 7. PR-by-PR decomposition (ordered; each independently green + CI-gated)

> **LANDED.** This decomposition is the historical record of how the cutover was
> built — every PR below merged (the WS-A build #511–#520, then the WS-B deletions
> #521–#527). The flag-gated/old-path-stays-live language is the as-built sequencing;
> the end state is the single unconditional jj-native path.

**WS-A — build the jj-native assembly path (additive; nothing deleted; old path stays live
the whole time).**

- **PR-1 — schema + read-model for the ancestor stack (additive).** Add
  `runs.ancestor_stack jsonb` (nullable; new migration, serialize vs other migration PRs).
  Dual-write: keep writing `speculative_base`/`integrated_ancestor_shas` AND the new column
  from the walker/percolation. Add a typed `AncestorStack` + a pure resolver that reads
  either. _Stays working:_ everything (column is unread). _Files:_ new migration,
  `contracts/integrationNodes.ts` (reuse `IntegrationNodeMember`), a new
  `engine/dag/ancestorStack.ts`. _Dep:_ none.
- **PR-2 — pure ancestor-stack resolver.** Extract `loadAncestorBranches`
  (`speculativeIntegrator.ts:131`) into a standalone DAG-ordered stack resolver (org-scoped,
  RLS-safe) with its own unit tests; `PgSpeculativeIntegrator` delegates to it (no behavior
  change). _Dep:_ PR-1.
- **PR-3 — the bootstrap-assembly seam + conformance.** Add a `withJjLocalIntegration`
  bootstrap variant (continuation = "create run branch at integrated head + keep workspace
  open for the writer") and a `bootstrapDependentBase(stack, runnerWorkspace)` over it,
  with a **new conformance suite** (`ancestorStackAssembly.conformance.test.ts`) mirroring
  the batch conformance: ordered stack, conflict surfaces, never-discard, clean head
  materialized. Not wired into the run path yet. _Dep:_ PR-2.
- **PR-4 — wire the run bootstrap behind a flag.** `plannerRunWorkspace.ts` /
  `plannerRunAdapters.ts`: when `ancestor_stack` non-empty AND
  `WALKER_JJ_LOCAL_BASE` (new flag, default OFF in this PR), bootstrap via PR-3's assembler;
  else the current single-ref clone. _Stays working:_ flag-off = today's behavior exactly.
  _Dep:_ PR-3.
- **PR-5 — stacked-PR base + retarget walk.** `githubDraftPr.ts` bases the PR on the
  immediate-ancestor branch (flag-gated); `mergeDispatch.ts` retarget walks one step down
  the stack on ancestor merge. _Dep:_ PR-4.
- **PR-6 — base-shift over the stack.** `baseShiftLiveSeams.ts` / `baseShiftCoordinator.ts`:
  the opener assembles the re-resolved stack locally instead of cloning `${newBaseRef}@origin`;
  `keepRun` re-points `ancestor_stack` (flag-gated). _Dep:_ PR-4.
- **PR-7 — flip the flag default ON + apex/real-jj validation.** `WALKER_JJ_LOCAL_BASE`
  default ON; run the realjj + walker/percolation/base-shift suites green; one apex-tier
  live exercise. The old synthesized-ref path is now dead but still PRESENT (kill-switch).
  _Dep:_ PR-5, PR-6.
- **PR-8 — `integration_nodes` UPSERT from the dependent bootstrap (`eager_base`).** The
  bootstrap assembly UPSERTs the eager node (proof-reuse substrate); observe-only. _Dep:_ PR-7.

**WS-B — the §7 deletions (LAST; only after WS-A is flag-on and proven).** These fold into
the tanren-owns-the-engine §7 deletion workstream.

- **PR-9 — delete `SpeculativeIntegrator` + `PgSpeculativeIntegrator` + walker/percolation
  integrator wiring + their conformance** (replaced by PR-3's suite). Remove the
  `WALKER_JJ_LOCAL_BASE` flag (path is now the only path). _Dep:_ PR-7/PR-8.
- **PR-10 — delete `VcsProvider.buildIntegrationBranch`** + the batch `buildIntegrationBranch`
  fallback (after `INTEGRATION_NODES_DRIVE` is made unconditional). _Dep:_ PR-9.
- **PR-11 — delete `cleanupIntegrationBranch` + the `tanren/integ` event-payload fields.**
  _Dep:_ PR-10.
- **PR-12 — migration: drop `runs.speculative_base` + `runs.integrated_ancestor_shas`** and
  remove `resolveSpeculativeState`'s single-ref semantics (the stack column is sole source
  of truth). Migration LAST so no green PR ever straddles a column drop. _Dep:_ PR-11.

**Discipline:** WS-A PRs are additive + flag-gated, so each is independently shippable on
green CI with the live path unchanged until PR-7. The deletions (WS-B) only land after the
replacement is proven, satisfying "deletions LAST". Serialize PR-1 and PR-12 (migration
edits) against other migration PRs per `docs/playbooks/parallel-orchestration.md`.

## 8. Verification (per WS-A PR)

`just affected-typecheck` + `just affected-test`, plus the targeted suites:
`tests/conformance/speculativeIntegrator.conformance.test.ts` (until WS-B replaces it),
`tests/dagSpeculativeIntegratorPg.test.ts`, `tests/dagWalkerSpeculative.test.ts`,
`tests/dagPercolationOperation.test.ts`, `tests/dagBaseShiftCoordinator.test.ts`,
`tests/dagBaseShiftLive.test.ts`, `tests/dagBaseShiftShiftedBase.test.ts`,
`tests/githubDraftPr.test.ts`, `tests/runExecutionContext.test.ts`,
`tests/integrationNodes.persistence.test.ts`, and the new
`ancestorStackAssembly.conformance.test.ts` (PR-3). Realjj coverage: extend the live jj
assembly tests to the multi-ancestor bootstrap. Self-guard the realjj GIT_DIR leak
(`#506`) on every push.
