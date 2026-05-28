# Phase 2B Execution Plan & Session Checkpoint

_Last updated 2026-05-28. This is the working execution plan + decision log for
getting through Phase 2B. ROADMAP.md carries the canonical phase/spec table;
this doc carries the **how** (streams, subagents, verification) and the
**session decisions** that aren't obvious from the code._

## Current state (2026-05-28)

- **Phase 2A: COMPLETE.** All P2A specs (0001–0020) merged on `main`.
  - `acceptance-easy` is **live-proven** on current main: run `run_cd09b273…`, `phase2_easy_complete`, draft PR `cat-cave/tanren-fixture-easy#7`, CI passed.
  - `acceptance-medium` **mechanism is live-proven** (≥2 subtasks, genuine checker rejection → `planner.rerequested` re-plan, credit-drawdown accounting, explicit-criteria intent-checking). Full-green is Phase-3-gated (see decision 3).
- **Hi-fi handoff bundle imported** at `tanren-hi-fidelity/` (PR #57): `shared.jsx` (TopBar/SideNav/ForgePalette), `app.jsx`, all `view-*.jsx`, `tokens.css`/`styles.css`, assets, **screenshots**, design-chat transcripts. Excluded from oxlint (vendored design prototypes; recreate pixel-perfect, do not maintain as source).
- **Dashboard** (`services/dashboard`): Hono server-rendered JSX stub — home (runs list), run detail, auth delegation to orchestrator `/auth/me`. Design tokens wired (`src/design`) but not yet consumed by UI. Ready for the P2B-0001 shell.
- **Dev stack**: rebuilt + synced to main this session; runner image bundles codexbar + ccusage + codex; usage probe validated over SSH. The dev Postgres auto-migrates on acceptance bootstrap (now includes 0016 credits `cost_basis`).
- **Session PRs merged**: #51 usage monitors · #52 usage→loop wiring · #53 planner run-trigger · #54 credits accounting + credit-aware pressure · #55 medium-gate correction · #56 P2A-0002 acceptance-criteria docs · #57 hi-fi import.

## Session decisions (load-bearing; not obvious from code)

1. **CI is the gatekeeper.** Never merge a PR without full green CI AND the branch up-to-date with `main`. Every change ships as a PR through this gate.
2. **Cost accounting.** Token-type accounting is mandatory and disjoint (input/cached/cache-creation/output/reasoning/total); dollar cost is best-effort. Bases: `provider_pricing`, `ccusage`, `credits`, `unknown` (honest NULL). **Credit drawdown** = `(creditsAtStart − creditsAtEnd) × $0.04/credit` (observed ChatGPT-Pro rate: 1000 credits/$40; $10/250), apportioned across the run's `cost_records` by token share, and it **outranks** notional ccusage token-pricing for subscription overage (within-window usage draws no credits, so a positive delta is the true marginal spend).
3. **Verification architecture split** (THE Phase 3 driver). Two categorically different mechanisms, never conflated:
   - **Deterministic gate-checks** (lint/typecheck/test/build/mutation/perf): direct automation on the runner workspace over SSH, exit-code-driven, **no agent**.
   - **Non-deterministic reasoning checks** (intent satisfaction, code review, P0/P1 security, stub detection): read-only **Answerer agents**.
   - Live evidence (3 `acceptance-medium` runs): the checker Answerer cannot run tests and must not be asked to ("`vitest: not found`" because the workspace was cloned but never `npm install`'d). It flip-flopped and never converged. Fixes required for full-green: per-repo **workspace bootstrap**, a **deterministic install+test gate**, and a checker prompt that **forbids running tests** (intent-only).
4. **Hi-fi = phase-agnostic full-product vision** (per design chat3). It builds out every surface with no "coming soon"/phase tags. **2B ships the acceptance-criteria subset** and stubs the rest (roadmap/personas/DORA/overview) as documented placeholders. Build to the *acceptance criteria* for scope, the *hi-fi* for the look of in-scope surfaces.
5. **Dashboard architecture: Hono SSR + a bundled client-"islands" layer** (esbuild step in `services/dashboard`) for genuine interactivity (⌘K palette, ink/ash toggle, project switcher, later SSE on run-detail). Theme persists via `data-theme` + `localStorage`. NOT a client SPA. _Pending explicit user confirmation; proceeding with islands unless they object._
6. **Window-pressure pre-flight is credit-aware**: a maxed subscription window is not a doomed call when credits cover overage; only escalate `window_exhausted` when `creditsRemaining` is null/0.

## Phase 2B dependency graph

```
P2B-0001 shell + auth + ⌘K palette + token consumption + client-islands + verification harness
        │  (SERIALIZATION POINT — must merge before any fan-out)
        ├─ P2B-0002 onboarding (org-setup 4-step + existing-project minimal) + credentials + notifications matrix
        ├─ P2B-0003 project view (chat-primary) + spec creation + routing & limits settings
        ├─ P2B-0004 run detail + review-handoff sub-surface
        ├─ P2B-0005 history & costs (4 cost sources, 3 pricing-mode views)
        ├─ P2B-0008 failure recovery (revise / replan / rollback / inspect)
        └─ P2B-0009 greenfield new-project (STRETCH; Phase 3 if not done)
                    │
        P2B-0006 operator-triggered live workflow  (needs 0002+0003+0004+0008 + P2A-0015)
                    │
        P2B-0007 phase-2 demo  (closes Phase 2)
```

Per-surface spec detail: `docs/roadmap/phase-2b-specs.md`. Per-surface acceptance criteria: `docs/design/acceptance-criteria/*.md`. Hi-fi source: `tanren-hi-fidelity/project/` (`view-*.jsx` + `screenshots/*.png`).

## Execution strategy (streams, subagents, verification)

**Step 1 — P2B-0001 (solo/focused, NOT parallel).** Build the shell + the conventions every screen depends on:
- Shell components (`components/shell/**`): `TopBar`, `SideNav` (4 groups; roadmap/personas/DORA/overview → placeholder routes per criteria), `ForgePalette` (`components/palette/**`).
- The **client-islands build** (esbuild) + the shared client runtime (palette open/keyboard, ink/ash toggle, project switcher).
- A small **API client** to the orchestrator product APIs (P2A-0013/0014) + session.
- Router/route-shell conventions (`app/**`) that screens slot into.
- The **verification harness**: `app.request` rendered-HTML assertions + a Playwright + screenshot setup that diffs against `tanren-hi-fidelity/project/screenshots/*.png`.
- GitHub OAuth sign-in lands into the shell (first sign-in creates org + admin per P2A-0003).

**Step 2 — fan out screen-streams as worktree-isolated subagents.** After P2B-0001 merges, dispatch parallel subagents (one per spec: 0002, 0003, 0004, 0005, 0008; 0009 stretch). Each:
- Owns a **distinct route subtree** (see each spec's `Owns` in phase-2b-specs.md) — no shared-file overlap.
- Is briefed with its acceptance-criteria doc + the matching `view-*.jsx` + screenshot.
- Ships as its own PR through the CI gatekeeper.

**Subagent coordination rules** (hard-won from earlier collisions):
- **Shell-first**: do NOT fan out until P2B-0001 is merged; the shell + client-islands + API client are shared hotspots that must be frozen first.
- **One migration in flight at a time** — if a screen needs a DB migration, serialize it (parallel subagents generate colliding migration numbers).
- Each subagent works in `isolation: "worktree"`; only its owned dirs.
- Trust-but-verify every subagent diff before merge; run the full local gate (tsc/tests/lint/format/arch/drift) per PR.

**Verification per screen**: the acceptance-criteria checklist + rendered-HTML tests + a Playwright screenshot diffed against the hi-fi PNG + (where it matters) operator visual QA. I cannot natively see a browser, so the screenshot harness + your eyes on golden flows are the visual gate.

## End of Phase 2 — capability delivered

Spec in → real PR out, entirely through the UI: GitHub-OAuth sign-in, org-as-tenant onboarding, repo link + credential import, spec submission, a real Codex workflow run (plan→write→check→audit→draft PR→CI), run-detail inspection (4-source cost bar incl. credits, trajectory, writer reasoning), failure recovery, and history/costs — no CLI or DB access. This is the v0 product milestone and the artifact to put in front of real users.

## Phase 3 opener — the gate-check cluster

First Phase 3 work (well-specified, evidence-backed by decision 3):
- **Repo-sourced tiered `tanren-ci.yml`** (config-bucketing: CI artifacts live in the target repo): named tiers (`fast` = lint/typecheck/unit; `slow` = integration/e2e/build/mutation/perf) with a `when` policy (`per_iteration` / `pre_audit` / `pre_merge`). One source of truth that BOTH GitHub Actions and the in-loop gate invoke.
- **In-loop gate-check stage** on the runner workspace (new `gate` task kind + `gate.*` events), exit-code-driven; fast tier per writer iteration, slow tier before audit.
- **Per-repo workspace bootstrap** (run the project's install command after clone).
- **Checker Answerer reframed to intent-only** (prompt forbids running tests/build).
- Optional: a root-cause agent that digests a gate failure report for the writer.
- Then the rest of Phase 3: review/merge automation (per-repo integrations), thick-Forge LLM backend + spec discovery + DAG canvas, provider expansion (Claude, opencode), subscription-window heatmap + DORA, live preview deploys, notification channel rollout, acceptance hard tier.

Phase 3 hi-fi prerequisites (must be locked before building those surfaces): thick-Forge interaction model + spec discovery, DAG-primary project view, review→merge flow, greenfield Forge interview, `tanren-config` audit gate.

## Pick up here

1. **Build P2B-0001** (shell + islands + verification harness). Serialization step.
2. Confirm the SSR-plus-islands decision (5) with the user if not already; proceed with islands otherwise.
3. After P2B-0001 merges, fan out P2B-0002/0003/0004/0005/0008 as parallel worktree subagents.
4. Local acceptance config (`tanren.acceptance.json`, gitignored) currently points `github_repo_url` at `cat-cave/tanren-fixture-medium`; both fixture repos exist (easy + medium, public). GitHub token file at `~/.config/tanren/acceptance-github-token`.
