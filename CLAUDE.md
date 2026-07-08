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
lint extended to flag ssh2 `timeout:`. apex v49 surfaced the doctrine's next
extension — task #21: derive's synchronous wait on the template-build child run
had no inner-failure circuit breaker, so a downstream runner-INSERT retry loop
presented as an 8-hour curl hang. Task #21A (runner-INSERT idempotency) shipped
as PR #705; the #21B child-run progress breaker was OBVIATED by PR-F #693, which
collapsed templating to fragment-only composition + the in-process F2 authoring
loop — the template-build child run + its synchronous-wait surface no longer
exist. The lint was further extended by PR #702 to close the audit-#672 evasion
paths (`cutoff/until/endsAt` families). The doctrine stands; disguised survivors
are caught and fixed (or obviated) as found. See
`docs/roadmap/timeout-eradication.md`. (2) **The
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
v37–v46 ran on the previous WSL host through 2026-06-19; v47–v79 have run on the
new NixOS host from 2026-06-23 through 2026-07-04, roughly a trial a day since
2026-06-28 — each flushed real engine bugs now fixed on `main`. **No run has yet
closed the full autonomous loop** (issue → triage → fix → merge → deploy → a
working product, no human in the inner loop). The v49-era infra halts (task #21
runner-INSERT PK race + derive synchronous-wait breaker) are gone. The v79-era
product-build-loop frontier (writer subtask sizing #731, plan stall recovery
#726, fragment-based composer PR-A #688 → PR-G #699, PR-enqueue timing #724
with the #725 atomic 3-write seam and orphaned-PR startup sweep, triage →
new-spec insertion #734) was HARDENED across three audit passes and a
cleanup wave. **34 PRs (#738–#768) landed 2026-07-05 → 2026-07-07** closed
every Codex-critic / round-3 / RA1 / RA2 finding: auditor prompt no-omit,
`routeOne` scope-first, `ensureFindingCoverage` empty-workItems P0
synthesis, `acceptProposals` newSpecs materialization, `specs` provenance
columns via migration 0025, partial unique index dedupe via 0027,
design-oracle finalize guard and typed `DesignContractCorruptError` /
`DesignOracleActorConfigError` / `MalformedDesignOracleResultError`
returns, `design_contracts.mode` column via 0026, `demo.failed` /
`usage.accounting_failed` event schemas with `DEFAULT_ROUTE_EVENTS` seed
and severity promotions, a unified `subscribeWithReconnect` helper across
4 subscribers, per-stage `task.failed` emit-on-throw with typed classifier
arms, and the timeout-eradication lint extended (PR #750) to catch bare
`_pages`/`_rounds`/`_turns`/`_cycles`/`_passes`/`_reworks` stems and
SCREAMING_CASE loop-cap patterns. **A subsequent Wave H + F2 hardening push
landed 26 more PRs (#774–#799) 2026-07-07** to close the pre-apex-v80
frontier. Wave H #774–#787 (14 PRs) landed the canonical fixed-point
signature and ATOMIC `createValidated` persistence seam via task #150,
guaranteed JIT env build reaching off-baseline toolchains, the design
contract unified on project-scope, the orgId invariant enforced at
hydration, allocators reclassified provisioning vs fixed-pool vs delegated
with provider resource id persisted, demo non-web arms with adapter-aware
surface dispatch, triage provenance columns SELECTed and exposed
downstream, durable manual_external deploy attestation with real operator
confirmation, notifications with no silent stubs and a durable no-route
record, and rejecting unknown deploy tokens with `testRunner` derived per
runtime. F2 Round I #788–#791 shipped per-attempt
`fragment.authoring.attempt` events plus writer prompt hardening
(exemplars, slot-kind guidance, prior-org fragments, product context) and
the runtime-validity smoke wired in prod construction (#789 was dead code
until #791). Round II #792–#795 hardened the parser to a balanced-brace
body walker with non-vfs statement rejection (replacing the lazy-regex
parser that truncated at the first `}` in a template literal); added the
iteration ceiling `FRAGMENT_AUTHORING_ITERATION_CEILING = 24` (integer
count, doctrine-compliant safety net over the 8-entry signature window);
and shipped real dep resolvers for python/go/rust. Round III #796–#799
landed parseStringLiteral single-pass unescape, sanitizer regex anchors
with an explicit `org_id` filter defense, RETRACT-WITH-DELETE (the
post-authoring batch-compose rejection deletes persisted rows so the org's
fragments table stays free of cross-run contamination), `succeeded`
deferred until the batch gate passes, the no-op apply()-body
stealth-downgrade class closed, and pip/go/cargo live invokers wired in
prod. The autonomous-loop machinery AND the F2 authoring pipeline are
complete and hardened by regression pins. **The honest open frontier for
v80: closing the full autonomous loop end-to-end** — no single run has yet
produced merged product spec → build → planted-issue auto-triaged →
merged fix → live deploy → a working product URL. That close is what apex
v80 must prove. The pre-hardening of F2 means the run should reach further
into the greenfield product-build loop than any prior trial before
surfacing the next real bug.

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
   project DAG seeds from a **fragment-composed template**; a missing fragment
   spawns the per-fragment authoring DAG (F2 — writer → validate, fixed-point
   convergent) or halts loud (`FragmentAuthoringFailedError` → `409
fragment_authoring_failed`). PR-F #693 collapsed the prior creation meta-flow
   and `template.*` events into this single fragment-only path. DO NOT pre-seed
   fragments; apex must exercise the F2 authoring path. Watch
   `fragment.authoring.{started,succeeded,failed}`, never the removed
   `template.*` events.

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
