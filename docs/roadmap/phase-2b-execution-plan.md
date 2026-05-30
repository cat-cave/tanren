# Phase 2B Execution Plan & Session Checkpoint

_Working execution plan + decision log from the Phase 2B build. **Phase 2B is
complete and Phase 3 has since shipped** (the run executor that closes the loop
landed as P3-0001) — this doc is retained for the **how** (streams, subagents,
verification) and the **session decisions** that aren't obvious from the code.
For current phase status see [`../../ROADMAP.md`](../../ROADMAP.md) and
[`phase-3-specs.md`](phase-3-specs.md)._

## Phase 2B progress (updated 2026-05-28, session 2)

- **P2B-0001 shell: MERGED** (PR #59) — TopBar/SideNav/ForgePalette, client-islands esbuild build, typed orchestrator client, GitHub-OAuth landing, `app.request` test harness. Child screens mount via the **append-only `services/dashboard/src/app/screens.ts` registry** + reuse `renderShell`/`loadShellContext`; `mountShell` gap-fills placeholders only (order-robust). Playwright e2e is local-only, NOT in the CI gate.
- **Wave 1: MERGED** via integration PR **#65** — P2B-0002 (onboarding + credentials + notifications, incl. a new orchestrator notifications route), P2B-0003 (chat-primary project view + spec creation + routing settings), P2B-0004 (run-detail + review + live SSE), P2B-0005 (history + costs). Built in parallel (#62/#60/#63 + #61); #61 merged solo, the other three reconciled in #65.
- **Wave 2: MERGED** (PR #66) — P2B-0008 failure recovery: halted-run page + four recovery actions (revise/replan-with-steering/rollback/open-inspection-thread) as authz'd orchestrator routes; lineage persisted via new `recovery.*` **events** (migration 0017 + event-type/sensitivity additions), not a bespoke table.
- **Remaining (at the time of this checkpoint):** P2B-0009 greenfield (STRETCH — migrated to Phase 3 as P3-0015 full greenfield, which has since shipped); P2B-0006 operator-triggered live workflow; P2B-0007 phase-2 demo. **All since resolved:** the trigger/live-workflow wiring shipped, and the real run executor (the implicit prerequisite) landed in Phase 3 as **P3-0001**; the live closeout demo is re-homed as **P3-0009** (pending real credentials to record).
- **Load-bearing lesson:** parallel agents must NOT all extend the same `OrchestratorClient` — divergent private `getJson`/`sendJson` + duplicate `listRuns` forced the #65 integration pass. Client is now split into `api/{httpClient,orchestrator,palette,types}.ts`; P2B-0008 correctly used its own `api/recoveryClient.ts`. Give future parallel client-touching screens their own api modules up front.

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
4. **Hi-fi = phase-agnostic full-product vision** (per design chat3). It builds out every surface with no "coming soon"/phase tags. **2B ships the acceptance-criteria subset** and stubs the rest (roadmap/personas/DORA/overview) as documented placeholders. Build to the _acceptance criteria_ for scope, the _hi-fi_ for the look of in-scope surfaces.
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

## Status (resolved)

_Phase 2B is complete and Phase 3 has shipped on top of it. The "pick up here"
back-half below has been done; it is retained as the record of what was outstanding
at this checkpoint and how it resolved._

1. **P2B-0006 — operator-triggered live workflow:** the trigger + end-to-end wiring shipped (`services/dashboard/src/routes/runs/trigger/**`, the orchestrator live tests, `docs/operator-guide/operator-driven-run.md`). The implicit prerequisite — a service-side run executor that actually dequeues the `plan` job — was **not** part of 2B; it landed in Phase 3 as **P3-0001** (`TANREN_RUN_WORKER=1`). With P3-0001, a dashboard-triggered run runs autonomously through plan→write→check→audit→gate→draft-PR→CI.
2. **P2B-0007 — phase-2 demo:** re-homed as **P3-0009** (the closeout demo can only run for real on the Tier-1 loop). It is the recorded live proof, pending real credentials to execute.
3. **P2B-0009 greenfield (thin stretch form):** superseded by the full greenfield track **P3-0015** (multi-round Forge interview → derived spec DAG), which has shipped.
4. The direct-execution `scripts/acceptance/{easy,medium}.ts` recipes referenced earlier were **removed** when P3-0001 landed; the system is now exercised only through the real dequeue→execute path.

> **Historical note on the gate-check cluster:** full-green of an autonomous run depended on the Phase-3 gate-check cluster (per-repo workspace bootstrap + deterministic install/test gate + intent-only checker), per [[verification-architecture-split]]. That cluster shipped as P3-0004/0005/0006/0007, so a fully-autonomous green run is no longer gated on unbuilt work — only on real credentials for the live demo.
