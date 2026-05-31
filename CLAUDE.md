# Tanren — start here (for agents)

Tanren turns specs into merged PRs through an agent workflow that runs each unit
of work per-PR through real CI. **v0 (Phases 0–3) is built and merged on `main`.**

## Read order for a fresh session

1. **`README.md`** — current state up top + the honest pending/deferred list.
2. **`docs/roadmap/forward-roadmap.md`** — the single authoritative forward plan across all four dimensions; this is the live to-do.
3. **`ROADMAP.md`** — phase history + exit criteria; the "pending/deferred" list near the end points here.
4. **`docs/operator-guide/live-validation-findings.md`** — exactly where the live demo stands + the config gotchas to resume it.
5. **`PROJECT_BRIEF.md`** — the durable source-of-truth vision.

## What's next (pull from `docs/roadmap/forward-roadmap.md`, not from memory)

The critical path: **A unblocks B; P3c + Vault per-run creds and the data-access layer are the top structural items.**

- **A — finish a real run (the gate).** The live demo is paused at the **harness-integration frontier**: worker→runner SSH auth (`All configured authentication methods failed`), the real codex/claude/opencode write stage, and draft-PR → CI (`tanren-ci.yml`) → Mergify merge. Plus the durable credential registry (the in-memory `CredentialRegistry` loses creds on restart). A live run needs a **fresh/reset dev DB** (`0026` makes `org_id` NOT NULL).
- **B — pipeline experimentation.** B0 == finishing A. Then the tanren-method benchmark (`docs/roadmap/tanren-method-benchmark.md`).
- **C — refactor/scale prepwork.** Top items: complete the data-access layer; `LISTEN/NOTIFY` to kill 1s polling; finish type-sharing + a `typify→serde` codegen.
- **D — managed-hosting.** RLS + plane-split P1→P3b are **done + live-validated**. Remaining: P3c (route run/spec/task lifecycle writes through the control plane), Vault per-run scoped creds, allocator-service org threading.
- **Held:** agy harness (broken headless); GitLab/VCS abstraction (GitHub-coupled via Mergify/Actions); the Rust rewrite/native harness.

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
