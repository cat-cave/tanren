# Tanren owns the engine — jj workspace, minimal GitHub, unified runs, guaranteed merge authority

> Status: **COMPLETE — the cutover is the single live path** (Waves 0–3 merged;
> the WS-A/WS-B series landed the deletions). Supersedes the "speculative execution
> / percolation" framing in `autonomy-engine.md §2c` — that doc's §2b/§2c are
> rewritten to this model. Origin: the live apex run stalled on a merge-queue
> conflict the resolver never engaged (run-discipline trigger); five Codex audits +
> the operator's reframe.
>
> **What is DONE (the live path on `main`):** the four seam contracts + conformance
> suites (Wave 0); the jj `WorkspaceVcsCore`, minimal `CodeHost`, guaranteed
> `MergeAuthority`, best-effort `VisibilityProjection` impls (Wave 1); the unified
> `integration_nodes` run model, `MergeAuthority` as the sole merge decision, the
> never-discard `BaseShiftCoordinator`, and audit-as-P0–P3-findings gated by
> `auditPosture` (Wave 2); the live jj conflict resolver, live base-shift execution,
> and `integration_nodes` proof-reuse + jj-local integration (Wave 3); and — in the
> WS-A/WS-B follow-on series — the **walker/percolation → jj-local cutover** and the
> deletion of the kill-switch flags themselves. The cutover is **no longer
> flag-gated**: there are no `MERGE_AUTHORITY_LIVE` / `CONFLICT_RESOLVER_JJ_LIVE` /
> `BASE_SHIFT_LIVE` / `INTEGRATION_NODES_DRIVE` / `WALKER_JJ_LOCAL_BASE` env vars —
> each live path is unconditional. The dependent run's base is jj-assembled locally
> from the **real ancestor PR-head refs** (`runs.ancestor_stack`); there is **no
> orchestrator-synthesized `tanren/integ` host ref**, and the legacy
> `runs.speculative_base` + `integrated_ancestor_shas` columns are dropped. The
> never-discard base-shift rebase and the `MergeAuthority` + `CodeHost` CAS land are
> the only paths. The `integration.*` metrics read-side (`rebase_vs_rebuild`) is
> **built** — the route, the compute reducer, and the insights loader are live.
>
> **What landed since (the §7 decomposition):** the 26-method God-`VcsProvider` is
> **fully DELETED** — decomposed across a 9-PR series into the minimal `CodeHost` +
> best-effort `VisibilityProjection` (the `mergeable_state` read was severed to
> `CodeHost.compareRefs` ancestry). The files `engine/contracts/vcsProvider.ts`,
> `providers/githubVcsProvider.ts`, `buildVcsProvider.ts` (and the
> `VcsProviderCodeHost` / `VcsProviderVisibilityProjection` adapters,
> `PgSpeculativeIntegrator`) are gone; the surviving primitives moved to
> `contracts/codeHostTypes.ts`, `providers/githubRepoRef.ts`, and the typed-pg-row
> seam `engine/data/pgRows.ts`. A `grep VcsProvider services/*/src` now finds only
> historical doc-comments, not a live interface.
>
> **What remains (separate, not the cutover):** one §7 simplification —
> `resolveSpeculativeState` / the stacked-PR retarget
> (`workflow/reviewMerge/speculativeStackRetarget.ts`) still live in the merge
> dispatcher. This is **not dead percolation**: it is the jj-local `ancestor_stack`
> base + PR-base retarget walk (`walker-jj-local-integration-design.md` §3.2/§3.3),
> a net-keep mechanism whose only open question is a possible rename off the
> "speculative" vocabulary. The live cutover paths are **first exercised
> end-to-end by an apex run that reaches a merge** — none has yet (apex v32 halted
> at scaffold-bootstrap before a merge; v36 recovered to 10/11 on template creation
> but did not close the product→deploy loop; successive trials — v37–v46 ran on
> the previous WSL host through 2026-06-19; v47–v64 ran on the new NixOS host and
> drove real engine bugs to fixes; the 2026-06-30 → 2026-07-04 apex-daily cadence
> carried the frontier through v65–v79 — each halt producing a fix-on-`main` merge,
> the v79 frontier landing triage → new-spec routing on real out-of-scope findings
> (PR #734). The task-#21 runner-INSERT + derive synchronous-wait circuit-breaker
> class is merged (PR #705). **The v79-era product-build-loop frontier has since
> been HARDENED across three subsequent audit passes plus a cleanup wave** — 34
> PRs (#738–#768) landed 2026-07-05 → 2026-07-07 closed every Codex-critic /
> round-3 / RA1 / RA2 finding, including new migrations 0025 (`specs` provenance
> columns — `parent_spec_id`, `source_finding_ids`, `origin_triage_task_id`,
> `origin_run_id`), 0026 (`design_contracts.mode` with `(project_id, mode,
version)` unique index), and 0027 (partial unique index
> `specs_triage_provenance_unique` on `(project_id, parent_spec_id,
source_finding_ids)` for triage newSpecs dedupe). The autonomous-loop
> machinery is complete and hardened by regression pins; the v80 frontier is
> the fragment authoring path. The full loop has not yet closed), so a real
> merge through the jj/`MergeAuthority` path is the open live-validation item
> (the engine is the single path on `main` regardless).

## 0. The governing principle — guaranteed-internal vs best-effort-external

**Best-effort applies ONLY to strictly external interactions.** Publishing a
visibility mirror (a PR, a check, a comment) to a forge UI may fail and must never
block Tanren. **Every internal policy/validation decision is GUARANTEED**:
transactional, **fail-closed** (deny/hold on uncertainty), never silently skipped,
swallowed, or made contingent on an external call. A system that owns its own gates
must _prove_ the policy it claims to enforce is actually enforced.

The line is bright:

- **Guaranteed (fail-closed, transactional):** the merge-authorization decision, gate
  verdicts, audit-findings → policy → block/route, conflict-resolved-before-merge,
  org-scope/RLS, the budget ceiling, demo verification.
- **Best-effort (never affects the decision):** projecting the change/verdict/demo to
  GitHub's PR/check/comment UI for humans.

If an external publish fails, the merge still proceeds or holds **exactly** as the
internal decision dictated — the publish is a mirror, not a gate.

## 1. Purpose-based decomposition (replacing the 26-method GitHub-shaped `VcsProvider`)

We stop modeling "the forge" and model the **purpose**. Four seams:

| Seam                       | What it is                                                                                                                 | Provider?                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **`WorkspaceVcsCore`**     | local clone/branch/rebase/record-conflict/resolve/restack                                                                  | **jj** (jj-only — no git fallback)      |
| **`CodeHost`**             | minimal hosting: code source + push/fetch refs + read commits/diffs + **land an authorized ref into `main`** + create repo | GitHub / GitLab / Bitbucket / self-host |
| **`MergeAuthority`**       | the owned decision: _what makes merging into `main` okay_                                                                  | **Tanren — no provider, guaranteed**    |
| **`VisibilityProjection`** | best-effort mirror of the change as PR/check/comment                                                                       | optional, per-host                      |

Plus two **pluggable, not load-bearing** surfaces: an **OAuth IdP** (operator login —
one of several) and an **issue source** (the inbox connector — one candidate source).

GitHub becomes "a code source, maybe an OAuth surface, maybe an issue source —
**fundamentally not the engine**."

## 2. `WorkspaceVcsCore` = jujutsu (jj)

jj's native primitives **are** the machinery we were hand-rolling:

- **First-class conflicts** — a rebase that conflicts _still succeeds_; the conflict is
  recorded _in_ the commit and resolved later. Work is never discarded; "a conflict
  must never brick" is true _by construction_.
- **Automatic descendant rebase** + **conflict-resolution propagation** — editing/
  landing an ancestor auto-restacks the whole stack and propagates resolutions down.
- **Operation log** — every op is reproducible/undoable.
- **jj-lib (Rust) + production git backend** — GitHub stays a plain git remote.

**Boundary:** conflicted jj states stay **local** to the runner workspace; only
resolved, git-compatible refs are pushed to the host. jj replaces the _VCS-core_ half
only; the host/forge half is `CodeHost` + `VisibilityProjection`.

_(pijul — commutative patches — is a research-watch, not a near-term bet: its own
forge + immature ecosystem don't fit a GitHub-hosted world.)_

## 3. The unified run + `integration_nodes`

There is **one** run: _work on a base branch that may shift._ The base is
`main + an ordered set of not-yet-landed ancestor branches` — an **integration node**.
The same object is an eager dependent build, a merge-queue batch, and a stacked/chain
PR. Kill the speculative-vs-real and eager-vs-unrelated divergence entirely.

- **Never-discard:** a base shift (an ancestor lands, or an unrelated spec lands) is
  _new context_ — jj-rebase the existing branch, re-gate only affected tiers,
  re-plan **only** if the resolver/gate says the old work no longer fits. Never
  cancel-and-regenerate.
- **No depth cap:** once work is never discarded, deeper eager chains are just more
  rebases, all useful. Instrument `rebase_vs_rebuild` (tokens/wall-clock/CI-minutes)
  to _prove_ conflict-resolution costs less than rebuild — don't assume it.
- **Proof reuse:** a gate/CI verdict on a node is reused when
  `member_key (= hash(base_sha + ordered member shas)) + gate_config_hash +
policy_version (+ runner image/app-env/quarantine)` match — so batch proofs carry
  into the real merge, bisection reads prefix-node proofs, and a no-op rebase skips
  unaffected gate tiers.

## 4. Audit = findings-only; the policy decides the gate (the real DORA knob)

The auditor **emits findings** `{id, severity: P0|P1|P2|P3, title, body, fixHint}` and
makes **no** pass/fail/halt judgment. A per-project **`auditPosture`** policy turns
findings into the verdict:

- block reaching review/merge at `maxSeverity ≤ blockReviewAt`,
- P2/P3 → fix-in-place if the spec idles awaiting review, else auto-route as new DAG
  specs,
- a zero-defect shop can block on even P3; a demo-stage startup can block on nothing
  and route everything into the DAG.

One engine, every strategy — and DORA metrics + bug-report rates let a user _measure_
which strategy fits, instead of being forced into one.

## 5. `MergeAuthority` — the guaranteed core

One owned, host-independent, **fail-closed** decision. Inputs: gate verdict, audit
findings vs `auditPosture`, demo verification, HITL signoff (when required),
conflicts-resolved, budget. Output: `authorized | blocked | needs_attention`. The host
merge/push happens **only** on `authorized`, in the same transaction that records the
decision. This unifies what is today scattered across the gate + `governancePosture` +
review + audit + mergeability — and it is the concept that makes the host swappable
(the host just _lands what Tanren authorized_).

```ts
interface MergeAuthority {
  prepareIntegration(batch): Promise<{ resolvedRef; treeSha; conflicts: Finding[] }>;
  authorizeLand(input): Promise<LandAuthorization>; // fail-closed truth table
  land(auth: LandAuthorization): Promise<{ mainSha; auditId }>; // transactional
}
```

**Fail-open violations this must close (audit 7 — every one is a place "best-effort"
leaked inward; all guaranteed-internal):**

- **P0** percolation `decideSettle()` absorbs on `audited`/`review`/`merged` **without
  reading the review verdict** — a `changes_requested` re-exec can advance
  `verified_ancestor_shas` + unblock merge (`changePercolation.ts:244`,
  `percolation.ts:165`).
- **P0** `ensureUpToDate()` **proceeds to merge on `unknown`/`blocked` mergeability** —
  fail-OPEN on uncertainty (`mergeDispatcher.ts:253`); adjacent to today's stall.
- **P0** the external merge fires **before** the durable `merge.completed` + run/spec
  finalize — merge can land while internal state records failure
  (`mergeDispatcher.ts:169,356`). MergeAuthority must authorize→execute→reconcile, with
  a `merge_state_unknown` reconcile path, never a plain failure.
- **P1** the conflict applier's `git fetch||true` / `git merge||true` swallow infra/auth
  failures so the resolver reasons over incomplete evidence (`workspaceApplier.ts:43`).
- **P1** budget gate returns **unlimited** (`ceiling undefined, spent 0`) on unresolvable
  scope — fail-OPEN budget (`budgetGate.ts:80`).
- **P1** missing-org tenant reads return **empty DAG/snapshots** + skip event append
  instead of throwing — fail-OPEN RLS (`walkerPg.ts:94,277`, `percolationPg.ts:86,321`);
  `directRunStateWriter.ts:193` raw-pool fallback bypasses scope.
- **P1** percolation failures sit only in an in-memory `failed` bucket (no durable hold)
  while dependents keep processing (`percolation.ts:129`); spec/run finalize is
  non-atomic (`plannerRunFinalize.ts:169`).
- **P2** `run.failed` append is swallowed (`runFinalize.ts:48,80`); `demo.completed` is
  emitted even with failed probes — no fail-closed demo verdict (`demoEngine.ts:84`).

## 6. Minimal `CodeHost`

`CodeHost` = create repo · push/fetch refs · read commits/diffs/files · read default
branch · **land an authorized resolved ref into `main`**. Since Tanren is now the merge
authority, `land` is a plain push-to-`main` of the authorized commit — **not** the
host's "merge PR" API. The seam set (audit 9):

```ts
interface VisibilityProjection {            // all optional, all best-effort
  openOrUpdateChangeRequest?(p): Promise<{ url; number }>;
  publishGate?(verdict): Promise<void>;
  publishReview?(review): Promise<void>;
  retargetChangeRequest?(input): Promise<void>;
}
interface IssueSource { fetch(source): Promise<IngestedItem[]>; }   // GitHub = one of N
interface IdentityProvider { buildAuthorizeUrl(...); exchangeCode(...); } // OAuth = one of N
```

**Load-bearing GitHub coupling — SEVERED.** Where forge semantics once drove engine
control flow that had to become Tanren's: PRs as durable engine handles, GitHub review
state driving control flow, draft/ready gating merge, `mergeable_state`/`update-branch`
deciding freshness, the GitHub PR-merge endpoint _being_ the merge authority,
server-side merge refs, post-merge host-CI reads. With the §7 decomposition landed
this is done: the `mergeable_state` read was severed to `CodeHost.compareRefs`
(ancestry, not a forge verdict), the GitHub PR-merge endpoint is replaced by
`MergeAuthority` + a `CodeHost` CAS land, the server-side merge refs are gone (the
dependent jj-assembles from real ancestor PR-head refs), and the dead host-CI reads
(`readPullRequestChecks`, `publishCheck`) are deleted. GitHub/GitLab/Bitbucket/self-host
now differ only in `CodeHost` mechanics; PR/check/review are best-effort mirrors;
Tanren's DB/events are the source of truth for gate verdicts, findings, review/demo,
conflicts, merge authority, queue order, DORA.

## 7. It must get SIMPLER (a success criterion, not a hope)

Owning more = _less_ finagling with external semantics + cleaner unified concepts.
Audit 8's estimate: **~25–40% less code in this subsystem, and a much larger reduction
in state-machine _concepts_.** What goes: the conflict `git merge --no-ff` +
`--diff-filter=U` + `merge --abort` dance (→ jj records the conflict), `prepareCleanPrBranch`'s
detached-rebase gymnastics, the server-side integration-branch build + 409 handling,
the percolation supersede+regenerate path **and the strand reconciler it spawned** (a
bug-class _born_ of cancel+recreate — deleted, not fixed), inferred severity, the two
divergent base-shift handlers (→ one), and most of the GitHub-PR-shaped `VcsProvider`
(→ an 8-method minimal `CodeHost`). **If the refactor doesn't net-delete code, it's wrong.**

**Landed.** The cutover deletions are merged: the git-merge-abort conflict dance is
gone (jj records the conflict; the live resolver runs jj-first), the server-side
integration-branch build + 409 handling is gone (no synthesized `tanren/integ` ref —
the dependent jj-assembles from the real ancestor PR-head refs), `PgSpeculativeIntegrator`

- the percolation supersede+regenerate path + the strand reconciler are deleted, the two
  base-shift handlers collapsed to one never-discard `BaseShiftCoordinator`, and the
  kill-switch env vars are removed (each live path is unconditional). **And the §7
  decomposition itself is now done**: the 26-method God-`VcsProvider` is **fully
  DELETED** — split across a 9-PR series into the minimal `CodeHost` + best-effort
  `VisibilityProjection`, the `mergeable_state` read severed to `CodeHost.compareRefs`
  ancestry, the dead methods (`readPullRequestChecks`, `publishCheck`, …) dropped, and
  the surviving primitives lifted to `contracts/codeHostTypes.ts` /
  `providers/githubRepoRef.ts` / the typed-row `engine/data/pgRows.ts` seam. The net is a
  delete. **Still on disk** as the one remaining non-blocking simplification:
  `resolveSpeculativeState` / the stacked-PR retarget in the merge dispatcher — which is
  the live jj-local `ancestor_stack` base + retarget mechanism, not dead code (a
  possible rename off the "speculative" name is its only open item).

Guardrails (audit 8): use **jj-lib as the state authority, not CLI text-parsing**;
`CodeHost` may host but must **never decide** freshness/conflict/gate; one
`MergeAuthority`, never two gate authorities; preserve eager/dependent work but model it
as integration nodes in the one run body; migrate `speculative_base` + percolation/merge
events through an explicit compatibility read-model, not silent abandonment.

## 8. Action plan — parallel waves, audits, validation, back to apex

The waves below are **merged**; the per-wave status is inline. The kill-switch flags
have since been **deleted** (the WS-A/WS-B series) — each live path is unconditional,
so "(flag-on)" below means "merged then made the single path." A real merge through
the live jj/`MergeAuthority` path is the open live-validation item (no apex run has
reached a merge — v32 halted at scaffold-bootstrap, v36 recovered to 10/11 on
template creation without closing the product→deploy loop, successive trials —
v37–v46 ran on the previous WSL host through 2026-06-19; v47–v64 ran on the new
NixOS host and drove real engine bugs to fixes; the 2026-06-30 → 2026-07-04
apex-daily cadence carried the frontier through **v65–v79**, each halt producing a
fix-on-`main` merge — v79's frontier landed triage → new-spec routing on real
out-of-scope findings (PR #734). The task-#21 runner-INSERT + derive
synchronous-wait circuit-breaker class is merged (PR #705); the current frontier
lives in the product-build loop, not v49-era infra hangs. The full loop has not
yet closed), but the engine is the single path regardless (see the status header).

**Wave 0 — lock the design (this doc). DONE.** The four seam contracts +
`integration_nodes` schema + `auditPosture` policy shape + the guaranteed/best-effort
boundary, plus the **conformance suites written first** (the contracts are the durable
asset): workspace-core (rebase-succeeds-with-conflict, auto-restack,
resolution-propagates, op-undo, clean-export, never-push-conflicted), CodeHost
(refs/main/land), MergeAuthority (fail-closed truth table), VisibilityProjection
(best-effort, never blocks).

**Wave 1 — the seams. DONE.** `WorkspaceVcsCore`
(`engine/providers/jjWorkspaceVcsCore.ts`, **jj-only — the git fallback was NOT
retained**) · `CodeHost` (`githubCodeHost.ts`, minimal GitHub host + CAS land-to-main)
· `MergeAuthority` (the guaranteed fail-closed decision, `engine/merge/
mergeAuthorityImpl.ts`) · `VisibilityProjection` (`githubVisibilityProjection.ts`, the
best-effort PR/check mirror). Each was Codex-audited + gated + CI + merged.

**Wave 2 — unify on the seams. DONE.** `integration_nodes` (persisted,
observe-only first, with a compat read-model) · the unified run body (the
speculative-vs-real divergence killed) · the never-discard `BaseShiftCoordinator`
(jj-rebase in place replacing the percolation supersede+regenerate — the strand
reconciler **deleted**, net −906 src LOC) · `MergeAuthority` as the sole merge
decision · audit-as-P0–P3-findings + `auditPosture`
(authoritative in the merge decision). Absorbed the two apex stall fixes
(conflict-resolver-on-the-merge-path, intake-poller App→static cred) as natural
consequences, not patches.

**Wave 3 — leverage + proof. DONE.** jj into the live conflict resolver (§5-P1
closed) · live base-shift execution (never-discard rebase) · `integration_nodes`
proof-reuse + jj-local integration · `buildLiveJjWorkspace` (jj against a live
allocated runner). The follow-on WS-A/WS-B series then completed the
walker/percolation → jj-local cutover (the dependent run jj-assembles its base from
the real ancestor PR-head refs — no synthesized `tanren/integ` ref), **deleted the
kill-switch flags** (each path unconditional), dropped the legacy
`speculative_base` + `integrated_ancestor_shas` columns, and **built the
`integration.*` metrics read-side** — the `rebase_vs_rebuild` route + compute
reducer + insights loader (prove rebase < rebuild) are live.

**Between every wave: validation gates** — `just ci` + `just smoke` + the new
conformance suites + a Codex adversarial pass on the wave's diff; nothing advanced on a
red gate. The goal: when these land, **v+1 lands on the first try** because the failure
modes the audits found are gone.

**Documentation revision (with the code, not after). DONE.** `README.md`, `ROADMAP.md`,
`docs/architecture/autonomy-engine.md` (§2b/§2c rewritten to the unified never-discard
model), and `CLAUDE.md`. Code must embody the doctrine (the former doc/reality mismatch —
"NOT discard" while the old code discarded — is itself a bug now deleted).

**Back to apex (the live-validation vehicle):** rebuild the stack on the cutover
`main` → re-provision (codex/github/vercel over the API) → fresh derive (v+1) →
drive the autonomy loops. apex is the single path's first end-to-end exercise, and
**no apex run has reached a merge yet**: v32 halted at scaffold-bootstrap; v36
recovered to 10/11 on template creation but did not close the product→deploy loop;
successive trials — v37–v46 ran on the previous WSL host through 2026-06-19;
v47–v64 ran on the new NixOS host and drove real engine bugs to fixes
(timeout-eradication survivors #638, #640, ancestor-backoff #639, apex-mode
env-var eradicated #646, Lane T1 #659, then the audit-round-2/round-3 landings
2026-06-29 — writer-seam doctrine sweep #708–#714, priorEvents discipline
#715–#718, task-#21 runner-INSERT + derive circuit breaker #705). The
2026-06-30 → 2026-07-04 apex-daily cadence then carried the frontier through
**v65–v79**, each halt producing a fix-on-`main` merge (autostash gate artifacts
#715; F2 fragment-authoring observability #719; re-drive halt observability +
wandering-halt convergence detector #720/#721; enqueue pushed PR into
`merge_queue` #724 + atomic 3-write seam #725; eventStore accepts org-scoped
events #723; plan-stage answerer stall-recovery #726; squash writer commits
before clean-PR rebase #728; pnpm bootstrap non-interactive #733; compose smoke
recognizes Go/Python/Rust tests #729; reconcile duplicate `addEnvVar` across
fragments #730; planner one-concern-per-subtask sizing #731; `ActivityWatchdog`
neighbor-floor widened to 5 for agent-class execs #732; **v79** — triage routes
out-of-scope findings to new specs #734, the issue-triage → new-spec insertion
mechanic firing on real out-of-scope findings). **The v79-era frontier was then
HARDENED (2026-07-05 → 2026-07-07)** by 34 PRs (#738–#768) that closed every
Codex-critic / round-3 / RA1 / RA2 finding across Waves D1..D4 + E-fix + F —
notably the v79 loop-closure end-to-end fix (auditor prompt no-omit +
`routeOne` scope-first + `ensureFindingCoverage` + `acceptProposals` newSpecs
materialization + `specs` provenance columns via migration 0025 + partial
unique index dedupe via migration 0027), the design-oracle typed error union

- `design_contracts.mode` column (migration 0026), the `demo.failed` +
  `usage.accounting_failed` event schemas + severity promotions + default-route
  seeding, a unified `subscribeWithReconnect` helper across 4 subscribers, and
  the timeout-eradication lint extended (PR #750) to catch bare give-up stems +
  SCREAMING_CASE loop-cap patterns. The current frontier is inside the
  product-build loop; the v80 target is the fragment authoring path. The full
  loop has not yet closed. So a real merge through the live jj/`MergeAuthority`
  path is still the open validation item. The cutover itself is complete — the
  engine is the single path whether or not a given apex run reaches a merge.
