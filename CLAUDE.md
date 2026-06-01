# Tanren — start here (for agents)

Tanren turns specs into merged PRs through an agent workflow that runs each unit
of work per-PR through real CI. **v0 (Phases 0–3) is built and merged, and the
real run loop is live-validated end-to-end across three tiers (easy/medium/hard,
the hard one a private repo) — each reached a merged PR with real Codex + real
credentials.**

## Read order for a fresh session

1. **`README.md`** — current state up top + the quickstart.
2. **`docs/roadmap/tempering.md`** — the live forward tracker (the single live
   to-do): what's done, what's next near- and long-term, and how a fresh clone
   reproduces the validated state.
3. **`docs/roadmap/autonomy-engine.md`** — the plan for the largest remaining
   effort (DAG-walker · real-LLM Forge · native merge queue · `apex` · the
   stub-ban + real-e2e guardrails). The build starts here.
4. **`docs/roadmap/forward-roadmap.md`** — the detailed four-dimension reference
   (more granular than tempering.md).
5. **`docs/operator-guide/live-validation-findings.md`** — what the live
   validation proved across all three tiers + the config gotchas.
6. **`ROADMAP.md`** — phase history + exit criteria.
7. **`PROJECT_BRIEF.md`** — the durable source-of-truth vision.

## What's next (pull from `docs/roadmap/tempering.md`, not from memory)

The core promise — a real user gets merged PRs from specs, on public **and
private** repos, across easy/medium/hard governance tiers — is **done and
live-proven**.

**The active build is the autonomy engine** (`docs/roadmap/autonomy-engine.md`):
today the run loop is real but the _driver_ is manual (an operator triggers each
spec; the Forge ideation agents default to deterministic stubs). The plan makes
the DAG autonomous (DAG-walker · real-LLM Forge · webhook ingestion · a native
intent-preserving merge queue with speculative execution) and proves it with
`apex`. It starts with **P1·0** (delete the quota seam → budget-is-the-gate +
concurrency-to-config), then the DAG-walker. Everything else below is hardening,
content, and long-horizon items:

- **A — core run loop.** ✅ Done. The harness frontier is resolved; the loop
  converges reliably; private-repo clone auth works; the simulated reviewer
  (`reviewPolicy: simulated`) closes the human-review tier. Remaining: post-merge
  auto-issue creation.
- **B — pipeline experimentation.** The tanren-method **benchmark toolkit is
  code-complete** (entities/scorecard/reducers/runner/accept/CLI). Remaining: the
  **seed corpus** (tiered seed repos + hidden accept tiers) and running the
  experiments. See `docs/roadmap/tanren-method-benchmark.md`.
- **C — refactor/scale prepwork.** The `Repositories` seam + conformance is in;
  routes + run-lifecycle writes are migrated off raw SQL; `LISTEN/NOTIFY`
  replaced 1s polling. Remaining: the rest of the DAL (forge/quota/recovery),
  `typify→serde` codegen, the first whole-repo mutation baseline.
- **D — managed-hosting.** RLS + plane-split **P1→P3c** done + live-validated
  (events/cost AND run/spec/task lifecycle writes route through the control
  plane, `42501`-proven); the standalone allocator is org-threaded. Remaining:
  **Vault per-run scoped credentials** (the last big de-privilege; also remove
  the `?? "dev-root-token"` fallbacks in `main.ts` + `allocator/main.ts`).
- **Held:** agy harness (broken headless); GitLab/VCS abstraction (GitHub-coupled
  via Mergify/Actions); the Rust rewrite/native harness.

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
