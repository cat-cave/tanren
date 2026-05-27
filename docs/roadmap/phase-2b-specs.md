# Phase 2B Specs

Detail entries for the 9 Phase 2B specs (one is a stretch goal). Phase 2B is the operator dashboard and the first operator-driven live run. Scope framing, dependency graph, workflow inventory, prep notes, and exit criteria are in `ROADMAP.md`.

### P2B-0001 — dashboard-shell-and-auth-flow

**Owns**: `services/dashboard/src/app/**` shell, `services/dashboard/src/routes/auth/**`, `services/dashboard/src/components/shell/**`, `services/dashboard/src/components/palette/**`, `services/dashboard/tests/**shell**`.
**Consumes**: P2A-0003, P2A-0016, P2A-0019.
**Produces**: the dashboard application shell — top bar (org pill, project crumb, ink/ash, notifications, avatar), sidenav (org / projects / setup / onboarding groups), GitHub OAuth sign-in, project switcher, and the **⌘K Forge command palette** modal — all design-token-based.

**What**: Implement the dashboard shell against the locked hi-fi shell. GitHub OAuth sign-in lands here; first sign-in creates the org + user; sidebar/topbar/navigation surfaces are wired; the ⌘K palette opens a modal whose suggested commands are read from P2A-0019's Forge tool surface (read actions and the operator-button write actions). Sidenav rows for non-Phase-2 surfaces (org overview, roadmap, personas, DORA) render as documented placeholders. Child route bodies belong to P2B-0002…0009.
**Why**: Every other 2B screen lives inside the shell; landing it first unlocks per-screen parallelization. The ⌘K palette is shell-scoped chrome, not a per-screen feature, so it belongs here.
**How**: React Router shell components plus design tokens; per-route placeholders during 2B; auth flows talk to P2A-0003; palette items are typed from P2A-0019 and route through P2A-0013 for write actions.

**Test plan**: shell component tests, OAuth flow integration test with a recorded fixture, navigation tests, palette open/filter/select tests, build/lint, `corepack pnpm run check`.
**Quality bar**: every non-shell route is a documented placeholder; no untyped API call; palette never invokes a tool not declared in P2A-0019; ink/ash theme toggle uses tokens from P2A-0016 with no hardcoded colors.
**Real-functionality validation**: an operator can sign in with GitHub, see their org in the top-bar pill, see their projects in the switcher, navigate between placeholder routes, and open the palette with ⌘K to invoke a read tool (e.g. "go to run X") that routes to the corresponding child route.
**Worktree-isolation safety**: owns the shell, auth UI, and palette; does not own child route bodies.

### P2B-0002 — dashboard-onboarding-and-credentials

**Owns**: `services/dashboard/src/routes/onboarding/org/**`, `services/dashboard/src/routes/onboarding/existing/**`, `services/dashboard/src/routes/credentials/**`, `services/dashboard/src/routes/notifications/**`, `services/dashboard/tests/**onboarding**`.
**Consumes**: P2B-0001, P2A-0013, P2A-0017, P2A-0006.
**Produces**: two onboarding tracks against the hi-fi: **org setup (full 4-step track)** and **existing project · minimal (link-only)**.

**What**: Build the org-setup wizard end-to-end (4 steps: link GitHub org, credentials, notifications, infrastructure) and the minimal existing-project flow (1 step: pick a repo the GitHub app can see + fill the project config form, no recon agent, no config-injection PR). Stack health card pulls `/doctor` from P2A-0013. Credential CRUD uses P2A-0013 credential routes. Notification matrix UI is fully functional against P2A-0017's schema; only ntfy rows are marked as wired in v0. Cloud allocator rows in step 4 render as phase-badged stubs (already so in the hi-fi). Infrastructure step shows local-docker as the only v0-active allocator.
**Why**: First-time operators cannot proceed past sign-in without these surfaces; without them, credentials and projects are still injected from outside the UI. Brownfield is the only onboarding-of-real-work-into-Tanren path in Phase 2 (greenfield is stretch).
**How**: Screens consume typed P2A-0013/0017/0006 contracts; redaction is applied per P2A-0009; secrets are write-only inputs in the UI. Existing-project link flow calls P2A-0013's brownfield-link endpoint (which reads target-repo `.github/workflows/`, `.mergify.yml`, `CODEOWNERS` if present but writes nothing).

**Test plan**: screen unit tests, integration tests against fake P2A-0013/0017 routes, redaction tests for credential displays, brownfield-link smoke against the existing fixture-easy repo, `corepack pnpm run check`.
**Quality bar**: no credential value ever rendered after entry; health failures present operator actions; notification matrix rows for unwired channels visibly say so; brownfield link never asks for a PR or writes to the target repo in v0.
**Real-functionality validation**: an operator with a blank stack can complete org-setup, configure the ntfy target, link the fixture-easy repo, and import a Codex credential — entirely through the UI, no CLI.
**Worktree-isolation safety**: owns the org and minimal-existing onboarding tracks, credentials, and notifications surfaces. Does not own greenfield (P2B-0009) or brownfield recon/config-injection (Phase 3).

### P2B-0003 — dashboard-project-and-spec

**Owns**: `services/dashboard/src/routes/projects/**`, `services/dashboard/src/routes/specs/**`, `services/dashboard/src/routes/settings/**`, `services/dashboard/tests/**projects**`.
**Consumes**: P2B-0001, P2A-0013, P2A-0018, P2A-0019, P2A-0020.
**Produces**: the **chat-primary project view** (Forge attention queue + suboptimal callouts + activity feed + velocity card), the spec creation surface, and the settings · routing UI (6-role fallback chains + Vault per-cred policy + escape hatches).

**What**: Project view ships chat-primary mode only — the Forge narration card reading from P2A-0019 turns, attention queue derived from open runs and pending review handoffs, suboptimal callouts from P2A-0020 (retry_hotspot, model_mismatch, pace_anomaly only — others are Phase 3), activity feed reading from P2A-0014, velocity card showing milestone ETA against P2A-0018 milestones. Spec creation surface lets the operator pick a milestone, tag behaviors, and write a description; routing-chain UI lets the operator add/reorder fallback entries per role for all six roles (only Codex entries function in v0). The "Forge can edit settings via PR" caption visible in the hi-fi renders only when the org's audit-gate flag is on; in Phase 2 it defaults off, so edits land in DB directly. DAG-primary mode is documented as a placeholder route → Phase 3.
**Why**: Operators need to drive a real run from the dashboard without the CLI; the chat-primary project view is the operator home. The routing UI is functionally complete in Phase 2 because routing is functionally complete in P2A-0006 (just fewer providers available).
**How**: Screens consume typed P2A-0013/0018/0019/0020 contracts; spec form generated from Zod via P2A-0018; routing UI generated from the 6-role schema in P2A-0006; subopt callouts are rendered Forge turns with action buttons that call P2A-0013/0019.

**Test plan**: screen unit tests, integration tests against P2A-0013/0014/0019/0020, schema validation in the form layer, routing-chain reorder tests, subopt callout interaction tests, `corepack pnpm run check`.
**Quality bar**: every field bound to a typed schema; no free-text JSON editors in the v0 surface; subopt callouts never show fake data; routing UI handles 1- to N-entry chains correctly.
**Real-functionality validation**: an operator can create a spec for fixture-easy from the UI, attach it to a milestone, tag a behavior, configure its routing to use a specific Codex auth chain, and see the resulting attention-queue entry render correctly in the project view.
**Worktree-isolation safety**: owns project view (chat-primary), spec creation, and routing settings surfaces; does not own dag-primary mode or other settings sub-surfaces.

### P2B-0004 — dashboard-run-detail-view

**Owns**: `services/dashboard/src/routes/runs/**`, `services/dashboard/src/components/runDetail/**`, `services/dashboard/tests/**runDetail**`.
**Consumes**: P2B-0001 and P2A-0014.
**Produces**: the run detail screen displaying planner subtasks, write/check/audit timeline, events, costs, PR/CI state, and failure diagnostics.

**What**: Build the run detail screen against locked hi-fi. SSE feeds live updates; sections cover planner subtasks, task timeline, events list with redacted/raw access, cost breakdown by source, PR/CI status, failure diagnostics.
**Why**: This is the central operator inspection surface; it carries the workflow inventory's run-detail and failure-recovery criteria.
**How**: Consumes P2A-0014; respects P2A-0009 redaction; raw access shows the audit trail; cost section reads P2A-0011 records.

**Test plan**: screen unit tests, SSE integration tests with a fake stream, redaction-scope rendering tests, `corepack pnpm run check`.
**Quality bar**: no UI-specific shaping requested back into the API after spec exit; every visible field is contract-typed.
**Real-functionality validation**: a fixture-medium acceptance run is fully inspectable from this screen including the rejection loop.
**Worktree-isolation safety**: owns the run detail surface.

### P2B-0005 — dashboard-history-and-costs

**Owns**: `services/dashboard/src/routes/history/**`, `services/dashboard/src/routes/costs/**`, `services/dashboard/tests/**history**`.
**Consumes**: P2B-0001, P2A-0011, and P2A-0014.
**Produces**: prior-run history list and cost dashboards across all three cost models with provider and model attribution.

**What**: Build the history list and cost dashboard screens against locked hi-fi. Costs render per source (`provider_direct`, `codexbar`, `opportunity_computed`) and per model, with the three pricing-mode views from PROJECT_BRIEF §4.5.
**Why**: PROJECT_BRIEF §4.5 makes the three-cost-model view non-negotiable for v0.
**How**: Reads P2A-0011 records; reads P2A-0014 read API for filtered run lists.

**Test plan**: screen unit tests, cost-model rendering tests, history-filter tests, `corepack pnpm run check`.
**Quality bar**: every cost row shows its real source; no unknown-source placeholder; all three pricing modes render correctly.
**Real-functionality validation**: a stack with multiple fixture runs shows the operator a coherent cost picture.
**Worktree-isolation safety**: owns history and costs surfaces.

### P2B-0006 — operator-triggered-live-workflow

**Owns**: `services/dashboard/src/routes/runs/trigger/**`, end-to-end live wiring across P2B-0001…0005 + P2B-0008, `services/orchestrator/tests/**operatorLive**`, `docs/operator-guide/operator-driven-run.md`.
**Consumes**: P2B-0002, P2B-0003, P2B-0004, P2B-0008, and P2A-0015.
**Produces**: the first fully operator-driven live run — sign in, configure credentials, create project, submit spec, trigger run, watch detail, recover from a forced failure — all through the dashboard with no fixture-only code paths.

**What**: Wire the run-trigger button in the spec/run UI to the real workflow, exercise the full multi-subtask planner loop against fixture-easy and fixture-medium, force a failure on fixture-medium and exercise at least one P2B-0008 recovery card (revise spec → replan), and document the operator-driven flow.
**Why**: Phase 2 only succeeds when the dashboard can drive a real run AND recover from a real failure; either alone is insufficient proof.
**How**: Add the trigger UI; wire it to the existing P2A-0013 spec/run creation routes; rely on P2A-0014 for live updates; rely on P2B-0008 for recovery actions.

**Test plan**: operator-driven live smoke against fixture-easy, then fixture-medium, then fixture-medium with forced halt + recovery, contract tests for the trigger endpoint, `corepack pnpm run check`.
**Quality bar**: no operator step requires the CLI or DB access; failures are observable from P2B-0004 and actionable from P2B-0008.
**Real-functionality validation**: an operator completes a fixture-medium run fully through the dashboard with persisted cost, PR, CI, and subtask state, AND recovers a forced-halt run through the failure recovery surface without CLI access.
**Worktree-isolation safety**: owns the trigger surface and wiring docs.

### P2B-0007 — phase2-end-to-end-demo

**Owns**: `docs/operator-guide/demo.md`, recorded run evidence, ROADMAP closeout notes.
**Consumes**: P2B-0006.
**Produces**: the recorded Phase 2 proof — a fresh operator going from blank stack to merged-ready PR with no CLI or DB access.

**What**: Run the canonical demo script: blank compose, GitHub OAuth sign-in, credential import, project setup, spec submission, live run inspection, cost review. Record the run identifiers and PR URL in ROADMAP as Phase 2 completion evidence, mirroring the Phase 1 closeout pattern.
**Why**: Phase 2 closeout needs a single inspectable artifact like the Phase 1 `run_a347d451…` record.
**How**: Execute the demo script, capture run IDs and PR URL, commit closeout evidence under ROADMAP.

**Test plan**: live demo execution and recording.
**Quality bar**: the demo must succeed end-to-end with no operator falling back to the CLI; failures roll Phase 2B back into rework.
**Real-functionality validation**: closeout evidence becomes the new Phase 2 baseline for Phase 3.
**Worktree-isolation safety**: docs-only after the live run.

### P2B-0008 — dashboard-failure-recovery

**Owns**: `services/dashboard/src/routes/runs/failure/**`, `services/orchestrator/src/routes/recovery/**`, `services/orchestrator/tests/**recovery**`, `docs/operator-guide/failure-recovery.md`.
**Consumes**: P2B-0001, P2A-0012, P2A-0013, P2A-0014, P2A-0019.
**Produces**: the **halted-run recovery surface** from the hi-fi (`view-failure.jsx`) — context cells (what blocked it, last good commit, blocks downstream, elapsed at hatch) plus four recovery cards (revise spec, replan with steering, rollback to commit, open inspection thread) plus a flat downstream-impact list.

**What**: A dedicated page for runs whose `outcome ∈ {halted, escape_hatch_hit, retry_budget_exhausted}`. Backend recovery routes implement four actions: `revise_spec` (opens a spec-edit form in P2B-0003), `replan_with_steering` (re-invokes the planner with an operator-provided steering note appended to the spec), `rollback_to_commit` (rolls the workspace to a named commit and re-queues from there), `open_inspection_thread` (creates a Forge thread bound to the run via P2A-0019 with read access to the auditor/writer disagreement history). The recovery actions are operator-initiated through dashboard buttons, route through P2A-0013, and persist their outcome in the run lineage. The DAG-impact strip in the hi-fi renders as a flat list of downstream-blocked specs in Phase 2 (full DAG layout is Phase 3).
**Why**: Without a recovery surface, halted runs are dead ends. The hi-fi makes this a primary operator-recovery path; Phase 2's end-state requires the operator to recover a real failure without the CLI.
**How**: Recovery action routes are typed Zod endpoints. The page reads P2A-0014 run state and renders the four cards conditionally based on what's recoverable (e.g. rollback is disabled if no prior commit exists).

**Test plan**: recovery action unit tests, halted-run page rendering tests, integration tests for revise/replan/rollback against fixture-medium, `corepack pnpm run check`.
**Quality bar**: every recovery action persists a typed lineage record; rollback never destroys workspace state without confirmation; replan with steering carries the operator's note into the next planner invocation.
**Real-functionality validation**: a fixture-medium run forced to halt by an auditor-disagreement scenario can be recovered by the operator via "revise spec + replan" through the dashboard, and the resulting re-plan run completes successfully.
**Worktree-isolation safety**: owns the failure-recovery page and the four recovery action routes; relies on P2A-0012 for planner re-invocation and P2A-0013 for spec-edit routing.

### P2B-0009 — dashboard-greenfield-new-project (STRETCH)

**Owns**: `services/dashboard/src/routes/onboarding/new/**`, `services/dashboard/tests/**onboardingNew**`.
**Consumes**: P2B-0001, P2A-0013, P2A-0018.
**Produces**: a **thin greenfield new-project flow** — a project-create form covering identity (name, description, repo target), a behaviors list (free-text, no Forge interview), and a milestone seed.

**What**: A single-step form for creating a project that does not yet have a repo or a derived spec DAG. The operator fills in title, description, intended GitHub repo (created empty or selected from existing org repos), and a free-text behaviors list that creates persona+behavior rows in P2A-0018. No Forge interview, no derived DAG, no sources/audits/arrival page. The "open project" button takes them to P2B-0003.
**Why**: The hi-fi has a full greenfield onboarding track (multi-round Forge interview → 71-spec DAG → arrival), but that's a Phase 3 surface (thick Forge + DAG canvas). A thin form ships as a stretch in Phase 2 so operators have *some* greenfield path. If 2B is otherwise on schedule, this lands; if not, greenfield waits for Phase 3.
**How**: Single Zod-form against P2A-0013 + P2A-0018 routes; no special backend beyond what those specs already provide.

**Test plan**: form unit tests, integration test against P2A-0013/0018, `corepack pnpm run check`.
**Quality bar**: form fields are all schema-typed; the resulting project loads correctly in P2B-0003; the page makes its thin-scope explicit ("Forge interview · phase 3+").
**Real-functionality validation**: an operator can create a new greenfield project through this form, attach a spec, trigger a run, and inspect it.
**Worktree-isolation safety**: stretch spec; if it doesn't ship in Phase 2, the sidenav route renders as a placeholder and greenfield migrates to Phase 3 entirely.

## Phase 2B Dependency Graph (full)

```text
P2A-0016 tokens + P2A-0003 auth ─→ P2B-0001 dashboard-shell-and-auth-flow (incl. ⌘K palette) ──┐
                                                                                                │
                                                                                                ├─→ P2B-0002 onboarding (org full + minimal existing)
                                                                                                ├─→ P2B-0003 project & spec (chat-primary)
                                                                                                ├─→ P2B-0004 run detail view
                                                                                                ├─→ P2B-0005 history & costs
                                                                                                ├─→ P2B-0008 failure recovery
                                                                                                └─→ P2B-0009 greenfield new project (STRETCH)

P2A-0011, P2A-0014, P2A-0019, P2A-0020 ─→ P2B-0004, P2B-0005, P2B-0008
P2A-0013 ─→ P2B-0002, P2B-0003
P2A-0018 ─→ P2B-0002, P2B-0003

P2B-0002 + P2B-0003 + P2B-0004 + P2B-0008 + P2A-0015 ─→ P2B-0006 operator-triggered-live-workflow ─→ P2B-0007 phase2-end-to-end-demo
```
