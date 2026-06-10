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

**The tanren-owns-the-engine cutover is merged + flag-on (merge paths still
apex-unproven).** Delivery now runs on the **jj (jujutsu) `WorkspaceVcsCore`**
(jj-only, no git fallback), the guaranteed fail-closed **`MergeAuthority`** (the
sole merge decision, replacing the scattered gate/governance/review/mergeability
checks), the unified **`integration_nodes`** run model, the **never-discard
`BaseShiftCoordinator`** (jj-rebase dependent work in place — the old percolation
that _superseded + regenerated_, discarding work, is replaced), and
**audit-as-P0–P3-findings** gated by an **`auditPosture`** DORA knob. These live
paths are **default-on behind kill-switch env vars** (`MERGE_AUTHORITY_LIVE`,
`CONFLICT_RESOLVER_JJ_LIVE`, `BASE_SHIFT_LIVE`, `INTEGRATION_NODES_DRIVE`). **apex
v32 ran live but halted at scaffold-bootstrap — it never reached a merge**, so the
flag-on jj/merge live paths are still **not apex-proven**; the §7 deletions (the
dead `speculativeIntegrator`, the git-merge-abort applier dance, the 25-method
`VcsProvider`) STAY deferred until a run actually reaches a merge. Rationale:
`docs/architecture/tanren-owns-the-engine.md`.

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
merge queue** coordinates merges, and the delivery path now runs on the flag-on
**jj / `MergeAuthority` / `integration_nodes`** engine (the cutover above; full
design rationale: `docs/architecture/autonomy-engine.md` +
`docs/architecture/tanren-owns-the-engine.md`; phase history: `ROADMAP.md` §2).

**The only remaining major effort is Phase 3 — `apex`**: the max-difficulty
fixture (rough operator notes → a deployed product autonomously). It is the
**active live-validation vehicle** — the operator contract
(`docs/operator-guide/apex.md`) and the live-run setup exist, the Tier-1
credentials (GitHub App + Slack + a deploy target;
`docs/operator-guide/validation-credentials.md`) are provisioned, and it spends
real credits under the $50 ceiling.

**To drive the next apex run (v33), a fresh agent reads, in order:**

1. **`docs/operator-guide/apex.md`** — the operator role (non-technical end user;
   never hand-fix the generated repo), the **run rhythm** (drive → halt →
   fix-on-`main` → drain backlog → rebuild → fresh `v(N+1)`), and the proof
   portfolio.
2. **`docs/operator-guide/apex-run-playbook.md`** — the **concrete drive-from-zero
   steps**: rebuild the stack from a FRESH `origin/main` checkout
   (`TANREN_APEX_MODE=1`/`TANREN_DEV_LOGIN=1`/`TANREN_REQUIRE_AUTH=1`), headless
   dev-login, BYOK Codex, import Tier-1 creds, kick off from rough notes, monitor
   for the next halt.
3. **`docs/roadmap/templating-system.md`** — the **templating doctrine**: every
   project DAG seeds from a VALIDATED template; a no-match triggers
   template-creation just-in-time or halts loud — there is **no from-scratch into a
   project**. DO NOT pre-create a template; apex must exercise creation-from-scratch.

**v33 = drive the refined platform; expect the next halt PAST scaffold** (v32
halted at scaffold-bootstrap and flushed #496/#497/#498). The rest of the forward
to-do (`ROADMAP.md` §4):

- **tanren-owns-the-engine — finish the cutover (post-merge-proof).** v32 never
  reached a merge, so the flag-on live merge paths are still unproven; these stay
  deferred until a run reaches a merge, then land: the §7 deletions (the dead
  `speculativeIntegrator`, the git-merge-abort applier dance,
  `resolveSpeculativeState`, the 25-method `VcsProvider` → ~5-method `CodeHost`),
  the walker/percolation → jj-local cutover, and the `integration.*` metrics
  read-side (prove rebase < rebuild). See
  `docs/architecture/tanren-owns-the-engine.md` §7–§8.
- **Thread `TANREN_APEX_MODE` to the orchestrator compose service** (v33-prep).
  Today it is wired only on the `worker` service, but the orchestrator reads it too
  (`engine/config/apexMode.ts`) — until threaded, export it on the host. One-line
  compose fix.
- **Benchmark seed corpus.** The tanren-method toolkit is code-complete; what
  remains is the **content** — tiered seed repos + hidden accept tiers + running
  the experiments. See `docs/roadmap/tanren-method-benchmark.md`.
- **Remaining DAL clusters.** Two forge stores still issue raw SQL
  (`forge/audits/store.ts` + `forge/inbox/store.ts`) — move them onto the
  `Repositories` seam; plus `typify→serde` codegen and the first whole-repo
  mutation baseline.
- **Residual hardening.** A few surviving Tier-2 backcompat items on a zero-users,
  single-baseline codebase: `schemaCore.ts` `.default('{}'::jsonb)` (latent-500)
  and the `resolveCredentials.ts` `orgId === ''` BYOK branch (a live path
  mislabeled "legacy").
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
