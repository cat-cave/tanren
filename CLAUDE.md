# Tanren — start here (for agents)

Tanren turns specs into merged PRs — **autonomously** — through an agent workflow
that runs each unit of work per-PR through real CI. **v0 (Phases 0–3) is built and
merged, and the real run loop is live-validated end-to-end across three tiers
(easy/medium/hard, the hard one a private repo)** — each reached a merged PR with
real Codex + real credentials.

**v21 native delivery is the doctrine.** Delivery is **Action-less**: the native
shell-tier gate (`.tanren/ci.yml`, a `CiConfigV1` — _not_ a GitHub Actions
workflow) runs over SSH and feeds the **sole merge authority**; the verdict
publishes back to the forge as the `tanren/gate` commit status. Mergify is fully
removed (`native_queue` is the merge engine); migrations are collapsed to a single
baseline; the status vocabulary is unified; Vault per-run scoped credentials are
done. (Tanren's own monorepo CI runs on GitHub Actions like any repo; the
no-Actions doctrine governs the delivery path for the apps Tanren _builds_.)

**The tanren-owns-the-engine cutover is COMPLETE — it is the single live path.**
Delivery runs on the **jj (jujutsu) `WorkspaceVcsCore`** (jj-only, no git
fallback), the guaranteed fail-closed **`MergeAuthority`** (the sole merge decision,
replacing the scattered gate/governance/review/mergeability checks), the unified
**`integration_nodes`** run model, the **never-discard `BaseShiftCoordinator`**
(jj-rebase dependent work in place — the old percolation that _superseded +
regenerated_, discarding work, is gone), and **audit-as-P0–P3-findings** gated by an
**`auditPosture`** DORA knob. The cutover is **no longer flag-gated**: the WS-A/WS-B
series deleted the kill-switch env vars (`MERGE_AUTHORITY_LIVE`,
`CONFLICT_RESOLVER_JJ_LIVE`, `BASE_SHIFT_LIVE`, `INTEGRATION_NODES_DRIVE`,
`WALKER_JJ_LOCAL_BASE`) — each live path is unconditional. The jj-native
`ancestor_stack` is the **sole base model**: a dependent run jj-assembles its base
from the **real ancestor PR-head refs** (true stacked PRs) — there is **no
synthesized `tanren/integ` host ref**, and the legacy `speculative_base` +
`integrated_ancestor_shas` columns are dropped. The never-discard base-shift rebase
and the `MergeAuthority` + `CodeHost` CAS land are the only paths. The
`integration.*` metrics read-side (`rebase_vs_rebuild`) is **built**. apex remains
the live-validation vehicle (a whole-product loop merging through the
jj/`MergeAuthority` path is the open validation item), but the engine is the single
path regardless. Rationale: `docs/architecture/tanren-owns-the-engine.md`.

**Two doctrine programs have since landed.** (1) **Timeout/retry-cap eradication —
the explicit family is eradicated + CI-gated** (#609–#622): the engine is PROGRESS /
SIGN-OF-LIFE based (`ActivityWatchdog` + `retryUntilConverged` wrapping
`convergenceDetector`; the `scripts/check-architecture-timeouts.mjs` lint is
CI-gating). A working agent runs **unbounded**; kill only on evidence of death.
**However the eradication was NOT 100% complete at ship**: apex v44/v45 surfaced two
_disguised_ survivors the initial lint missed — (a) the ssh2 connect-config `timeout:`
socket idle-timeout (#638), (b) the `ActivityWatchdog` liveness probe reading
newest-mtime, which a lock-file heartbeat defeated (#640). Both are now fixed and the
lint extended to flag ssh2 `timeout:`. **apex v49 surfaced the doctrine's next
extension — task #21**: derive's synchronous wait on the template-build child run
had no inner-failure circuit breaker, so a downstream runner-INSERT retry loop
presented as an 8-hour curl hang. The doctrine stands; disguised survivors are
caught and fixed as found. See `docs/roadmap/timeout-eradication.md`. (2) **The
native DESIGN subsystem is BUILT + wired** (WS-D1..D4): a domain-general persisted
`DesignContract` injected into the writer + a domain-aware design oracle re-driving
the writer in the same DAG (no handoff seam), bound to first-class personas +
behaviors. It is **not yet exercised on a live run with a captured contract** — the
full autonomous loop has not yet closed end-to-end. See
`docs/roadmap/native-design-subsystem.md`.

## Read order for a fresh session

1. **`README.md`** — current state up top + the quickstart.
2. **`ROADMAP.md`** — the single consolidated roadmap: current state, frozen phase
   history, the durable architecture posture, and the live forward to-do.
3. **`PROJECT_BRIEF.md`** — the durable source-of-truth vision.
4. **`docs/architecture/autonomy-engine.md`** — the durable design rationale for
   the autonomy engine (DagWalker · real-LLM Forge · native merge queue ·
   never-discard rebase + `MergeAuthority` · `apex` · the stub-ban + real-e2e
   guardrails); the merge-engine cutover lives in
   `docs/architecture/tanren-owns-the-engine.md`.
5. **`docs/operator-guide/live-validation-findings.md`** — what the live
   validation proved across all three tiers + the config gotchas.

## What's next (pull from `ROADMAP.md` §4, not from memory)

The core promise — a real user gets merged PRs from specs, on public **and
private** repos, across easy/medium/hard governance tiers — is **done and
live-proven**. The **autonomy engine** (autonomy Phases 1 and 2) is **merged on
`main`**: the DAG drives itself via the **DagWalker**, the **native intelligent
merge queue** coordinates merges, and the delivery path now runs unconditionally on
the **jj / `MergeAuthority` / `integration_nodes`** engine (the completed cutover
above; full
design rationale: `docs/architecture/autonomy-engine.md` +
`docs/architecture/tanren-owns-the-engine.md`; phase history: `ROADMAP.md` §2).

**The only remaining major effort is Phase 3 — `apex`**: the max-difficulty
fixture (rough operator notes → a deployed product autonomously). It is the
**active live-validation vehicle** — the operator contract
(`docs/operator-guide/apex.md`) and the live-run setup exist, the Tier-1
credentials (GitHub App + Slack + a deploy target;
`docs/operator-guide/validation-credentials.md`) are provisioned, and it spends
real credits under the $50 ceiling.

**Be honest about the proof state — do NOT overclaim.** Successive apex trials —
v37–v46 ran on the previous WSL host through 2026-06-19; v47–v49 ran on the new
NixOS host on 2026-06-23 — each flushed real engine bugs now fixed on `main`. **No
run has yet closed the full autonomous loop** (issue → triage → fix → merge →
deploy → a working product, no human in the inner loop). v49 drove past this
session's env + code cleanups into the live writer-checker-auditor LLM loop running
real scaffold work and halted on a **legitimate pre-session tanren-code finding**:
a runner-INSERT retry loop
(`duplicate key value violates unique constraint "runners_pkey"`) between the
run-executor and the job-reaper, compounded by derive's synchronous wait having no
inner-failure circuit breaker (8-hour curl hang). Task #21 tracks both fixes —
runner-INSERT idempotency + a progress/sign-of-life-based circuit breaker for
derive's synchronous wait. That close is exactly what apex still has to prove.

**To drive the next apex run, a fresh agent reads, in order:**

1. **`docs/operator-guide/apex.md`** — the operator role (non-technical end user;
   never hand-fix the generated repo), the **run rhythm** (drive → halt →
   fix-on-`main` → drain backlog → rebuild → fresh `v(N+1)`), and the proof
   portfolio.
2. **`docs/operator-guide/apex-run-playbook.md`** — the **concrete drive-from-zero
   steps**: rebuild the stack from a FRESH `origin/main` checkout
   (`TANREN_DEV_LOGIN=1`/`TANREN_REQUIRE_AUTH=1`), headless dev-login, BYOK Codex,
   import Tier-1 creds, configure the project's autonomy posture via the
   governance API (see the playbook's §2.5 — a single PUT), kick off from rough
   notes, monitor for the next halt.
3. **`docs/roadmap/templating-system.md`** — the **templating doctrine**: every
   project DAG seeds from a VALIDATED template; a no-match triggers
   template-creation just-in-time or halts loud — there is **no from-scratch into a
   project**. DO NOT pre-create a template; apex must exercise creation-from-scratch.

The rest of the forward to-do (`ROADMAP.md` §4):

- **tanren-owns-the-engine — cutover COMPLETE, §7 decomposition LANDED.** The
  walker/percolation → jj-local cutover landed, the kill-switch flags are deleted
  (each live path unconditional), the legacy `speculative_base` +
  `integrated_ancestor_shas` columns are dropped, and the `integration.*` metrics
  read-side (`rebase_vs_rebuild`) is built. The **26-method `VcsProvider` God-interface
  is now fully DELETED** — decomposed across a 9-PR series into the minimal
  `CodeHost` plus the best-effort `VisibilityProjection` (`mergeable_state` severed to
  `CodeHost.compareRefs` ancestry; dead methods dropped; primitives lifted to
  `contracts/codeHostTypes.ts` / `providers/githubRepoRef.ts` / the typed-pg-row
  `engine/data/pgRows.ts` seam). A `grep VcsProvider services/*/src` finds only
  doc-comments. The one thing still on disk is **not** dead code:
  `resolveSpeculativeState` / the stacked-PR retarget — the live jj-local
  `ancestor_stack` base + retarget walk (only a possible rename off the "speculative"
  vocabulary remains). A whole-product loop merging through the live
  jj/`MergeAuthority` path is the open live-validation item. See
  `docs/architecture/tanren-owns-the-engine.md` §7–§8 plus
  `docs/architecture/vcsprovider-codehost-decomposition.md`.
- **Benchmark seed corpus.** The tanren-method toolkit is code-complete; what
  remains is the **content** — tiered seed repos + hidden accept tiers + running
  the experiments. See `docs/roadmap/tanren-method-benchmark.md`.
- **DAL + neutral-schema tail.** The forge audits + inbox stores are now migrated
  onto the `Repositories` seam (`engine/repositories/{audits,inbox}.ts`) — that item
  is done. What remains is `typify→serde` codegen and the first whole-repo mutation
  baseline.
- **Residual hardening.** The `schemaCore.ts` `.default('{}'::jsonb)` defaults
  (a latent-500 source) survive on this zero-users, single-baseline codebase. The
  old `resolveCredentials.ts` `orgId === ''` silent-BYOK branch is already FIXED —
  it is now an explicit `OrgScope` discriminated mode (`{ kind: "org" }` vs
  `{ kind: "unscopedPlatform" }`) that fails loud (`UnscopedOrgError`) on a missing
  tenant scope rather than degrading to BYOK.
- **Held / long-horizon:** a second `CodeHost` backend (GitLab — the seam already
  shipped, decomposed from `VcsProvider` by the cutover; the Mergify/Actions
  coupling that once justified deferring it is gone); the agy harness (broken
  headless); the Rust rewrite / native harness.

## Working rules

- **CI is the gatekeeper.** Never merge a PR without full green CI and up-to-date-with-`main`.
- The full gate is **`just ci`** (`just fast-check` for the non-build steps) + **`just smoke`**. Run them before pushing. For a faster inner loop, **`just affected-typecheck` / `affected-build` / `affected-test`** run only what changed vs `origin/main`.
- **Toolchain** (oxc / native, no `tsc`): **tsgo** (`@typescript/native-preview`) does typecheck + build; **oxlint** is the fast linter and **`oxlint --type-aware`** (oxlint-tsgolint) is the typed pass (config `oxlintrc.typeaware.json`); **oxfmt** is the formatter (`.oxfmtrc.json`, `just format`); **vitest 4** is the test runner; **Turborepo** caches build/typecheck (`.turbo/`). vitest stays the mutation (Stryker, weekly) + e2e runner.
- Parallel work runs in isolated git worktrees, one unit of work per PR — see the discipline in **`docs/playbooks/parallel-orchestration.md`**. Serialize any PR that edits a DB migration or a shared file (nav, `screens.ts`, `main.ts`).
- Adapters are slottable behind contracts with conformance suites (`services/orchestrator/tests/conformance/**`); add a backend as a new impl + registry entry, not a refactor.
- Tenant queries run org-scoped (`db/src/orgScope.ts`); RLS denies by default, so a query off the scoped client sees **zero** rows. New tenant-table sites must carry org scope.

## Hi-fi design

The full-product vision lives in `tanren-hi-fidelity/`. When a new hi-fi revision
arrives, follow **`docs/design/hifi-revision-process.md`**. The current hi-fi ↔
implementation gap audit lives in `docs/design/phase-3-hifi-gaps.md`.
