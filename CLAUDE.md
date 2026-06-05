# Tanren — start here (for agents)

Tanren turns specs into merged PRs — **autonomously** — through an agent workflow
that runs each unit of work per-PR through real CI. **v0 (Phases 0–3) is built and
merged, and the real run loop is live-validated end-to-end across three tiers
(easy/medium/hard, the hard one a private repo)** — each reached a merged PR with
real Codex + real credentials.

**v21 native delivery is the doctrine.** Delivery is **Action-less**: the native
shell-tier gate (`.tanren/ci.yml`, a `CiConfigV1` — _not_ a GitHub Actions
workflow) runs over SSH and is the **sole merge authority**; the verdict publishes
back to the forge as the `tanren/gate` commit status. Mergify is fully removed
(`native_queue` is the merge engine); migrations are collapsed to a single
baseline; the status vocabulary is unified; Vault per-run scoped credentials are
done. (Tanren's own monorepo CI runs on GitHub Actions like any repo; the
no-Actions doctrine governs the delivery path for the apps Tanren _builds_.)

## Read order for a fresh session

1. **`README.md`** — current state up top + the quickstart.
2. **`ROADMAP.md`** — the single consolidated roadmap: current state, frozen phase
   history, the durable architecture posture, and the live forward to-do.
3. **`PROJECT_BRIEF.md`** — the durable source-of-truth vision.
4. **`docs/architecture/autonomy-engine.md`** — the durable design rationale for
   the autonomy engine (DagWalker · real-LLM Forge · native merge queue ·
   speculation + percolation · `apex` · the stub-ban + real-e2e guardrails).
5. **`docs/operator-guide/live-validation-findings.md`** — what the live
   validation proved across all three tiers + the config gotchas.

## What's next (pull from `ROADMAP.md` §4, not from memory)

The core promise — a real user gets merged PRs from specs, on public **and
private** repos, across easy/medium/hard governance tiers — is **done and
live-proven**. The **autonomy engine** (autonomy Phases 1 and 2) is **merged on
`main`**: the DAG drives itself via the **DagWalker** and the **native intelligent
merge queue** coordinates merges (full design rationale:
`docs/architecture/autonomy-engine.md`; phase history: `ROADMAP.md` §2).

**The only remaining major effort is Phase 3 — `apex`**: the max-difficulty
fixture (rough operator notes → a deployed product autonomously). It is the
**active live-validation vehicle** — the operator contract
(`docs/operator-guide/apex.md`) and the live-run setup exist, the Tier-1
credentials (GitHub App + Slack + a deploy target;
`docs/operator-guide/validation-credentials.md`) are provisioned, and it spends
real credits under the $50 ceiling. The rest of the forward to-do (`ROADMAP.md`
§4):

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
- **Held / long-horizon:** a second `VcsProvider` backend (GitLab — the seam
  already shipped; the Mergify/Actions coupling that once justified deferring it is
  gone); the agy harness (broken headless); the Rust rewrite / native harness.

## Working rules

- **CI is the gatekeeper.** Never merge a PR without full green CI and up-to-date-with-`main`.
- The full gate is **`just ci`** (`just fast-check` for the non-build steps) + **`just smoke`**. Run them before pushing.
- Parallel work runs in isolated git worktrees, one unit of work per PR. Serialize any PR that edits a DB migration or a shared file (nav, `screens.ts`, `main.ts`).
- Adapters are slottable behind contracts with conformance suites (`services/orchestrator/tests/conformance/**`); add a backend as a new impl + registry entry, not a refactor.
- Tenant queries run org-scoped (`db/src/orgScope.ts`); RLS denies by default, so a query off the scoped client sees **zero** rows. New tenant-table sites must carry org scope.

## Hi-fi design

The full-product vision lives in `tanren-hi-fidelity/`. When a new hi-fi revision
arrives, follow **`docs/design/hifi-revision-process.md`**. The current hi-fi ↔
implementation gap audit lives in `docs/design/phase-3-hifi-gaps.md`.
