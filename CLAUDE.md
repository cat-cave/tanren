# Tanren — start here (for agents)

Tanren turns specs into merged PRs through an agent workflow that runs each unit
of work per-PR through real CI. **v0 (Phases 0–3) is built and merged on `main`.**

## Read order for a fresh session

1. **`README.md`** — current state in the first ~25 lines + the honest pending/deferred list.
2. **`ROADMAP.md`** — phase-by-phase exit criteria; the "Still genuinely pending/deferred" list near the end is the live to-do.
3. **`docs/roadmap/expansion-and-strictness-plan.md`** — the adapter-seam / strictness / SaaS-priming / longevity tracks and what's deferred.
4. **`PROJECT_BRIEF.md`** — the durable source-of-truth vision.

## What's next (pull from `ROADMAP.md`'s pending list, not from memory)

- **Live demo + live validation (P3-0009)** — blocked on real credentials. See `docs/operator-guide/operator-driven-run.md`; note migration `0026` makes `org_id` NOT NULL, so a live run needs a **fresh/reset dev DB**.
- **agy / pi / reasonix harness adapters** — await each tool's CLI invocation spec; don't guess.
- **RLS + control-plane/data-plane split** — plan approved (`docs/roadmap/saas-rls-and-plane-split-plan.md`); **R1 (inert mechanism + restricted role) built**; R2 enables policies + flips the runtime role, R3+ convert the remaining query sites (`docs/roadmap/R-WAVES.md`).
- **GitLab / VCS abstraction** and the **Rust rewrite / native harness** — deliberately deferred / long-horizon.

## Working rules

- **CI is the gatekeeper.** Never merge a PR without full green CI and up-to-date-with-`main`.
- The full gate is **`just ci`** (`just fast-check` for the non-build steps) + **`just smoke`**. Run them before pushing.
- Parallel work runs in isolated git worktrees, one unit of work per PR. Serialize any PR that edits a DB migration or a shared file (nav, `screens.ts`, `main.ts`).
- Adapters are slottable behind contracts with conformance suites (`tests/conformance/**`); add a backend as a new impl + registry entry, not a refactor.

## Hi-fi design

The full-product vision lives in `tanren-hi-fidelity/`. When a new hi-fi revision
arrives, follow **`docs/design/hifi-revision-process.md`**. The current hi-fi ↔
implementation gap audit lives in `docs/design/phase-3-hifi-gaps.md`.
