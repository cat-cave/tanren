# Hi-fi ↔ Implementation Audit

This is the current hi-fi ↔ implementation gap audit (the doc CLAUDE.md points
to): an evidence-grounded audit of the locally-installed hi-fidelity design
bundle (`tanren-hi-fidelity/`) — the hand-done **reference for Tanren's own
dashboard** — against the codebase on `main`. It is the single home for
vision-delta tracking; the earlier running-log of vision changes has been folded in
(its "open" deltas were all already applied to the hi-fi — see the chat3
transcript).

> **Scope:** this audits the hi-fi bundle vs. the built dashboard. It is **not**
> about the native design subsystem (how Tanren designs the apps it _builds_) —
> that is built and lives in `docs/roadmap/native-design-subsystem.md`. The two are
> separate design pipelines; do not read a "design" gap here as a gap in that
> subsystem.

It contains two sets:

- **Set 1 — Hi-fi is BEHIND the implementation.** The built product moved past or
  intentionally diverged from the hi-fi. These are edits the **user** will make to
  the hi-fi to bring it current.
- **Set 2 — Implementation is BEHIND the hi-fi.** We are still code-behind the
  design. These become build work.

Every item cites the hi-fi source and the code path, and is marked
high/medium/low confidence. The hi-fi is explicitly a **phase-agnostic vision**
(chat4: "this hifi … a vision of what we want the product to be, NOT … tied to
any specific phase") — so "behind"/"ahead" here means _content/shape_
divergence, not roadmap phasing.

## Inventory: what the hi-fi specifies

From the bundle's `project/*.jsx` (router in `app.jsx`, nav in `shared.jsx`),
the hi-fi envisions these surfaces:

- **Project view** — chat-primary (Forge narrates) and DAG-primary (SVG canvas
  with legend, attention badges, pulsing live/review/blocked nodes), toggleable.
- **Spec surface** — a minimal slide-in **drawer** off every DAG node that
  escalates to a **full spec page** (BDD acceptance, deps, run history, economics,
  blocked-reason, "ask forge" actions). `view-spec.jsx`.
- **Run detail** — unified cost/window/spend bar + trajectory spine + reasoning
  pane. `view-run.jsx`.
- **Review handoff** — Forge-run inline review; readiness gate with per-repo
  merge-integration CTAs. `view-review.jsx`.
- **Spec discovery** — insight → classification → proposed specs → DAG placement →
  accept (feature/bug/strategic variants). `view-discovery.jsx`.
- **Candidate inbox** — configurable issue sources → dedupe/match/placement
  triage → accept-to-discovery. `view-inbox.jsx`.
- **Scheduled audits** — recurring Answerer-pass library + window-fill +
  forge-recommended coverage + composer. `view-audits.jsx`.
- **tanren-config** — config-as-code PR review (gate on/off). `view-config.jsx`.
- **Failure recovery** — halted run with recovery cards + DAG impact.
  `view-failure.jsx`.
- **Settings** — routing role→fallback chains, vault per-cred policy, escape
  hatches. `view-settings.jsx`.
- **History & costs** — all-source spend + 30-day utilization heatmap.
  `view-costs.jsx`.
- **Org surfaces** (`view-org.jsx`): **Overview** (org command deck),
  **Notifications** (channels + per-event matrix + delivery history + quiet
  hours), **Roadmap** (cross-project Gantt), **Personas** (cross-project
  people-models), **DORA** (4 tiles + lead-time chart).
- **Onboarding** (designer-only, pulled out of standing nav): org setup (4
  steps), greenfield new project (3 steps), brownfield existing (5 steps).
- **Forge** — the unified ⌘K palette that **morphs into a chat thread** (answers,
  follow-up chips, auto-navigate action cards). `shared.jsx` `ForgePalette`.

## Inventory: what the code actually mounts

Dashboard screen registry (`services/dashboard/src/app/screens.ts`) mounts:
projects (chat-primary + DAG + spec drawer/page + routing settings), onboarding
(org/credentials/notifications + brownfield + greenfield), costs, run-detail +
review, halted-runs, run-trigger, DORA, discovery, config, inbox, greenfield,
audits, merge queue, budget, integrations, and overview. The ⌘K Forge palette +
thick-Forge chat morph ships (`components/palette/ForgePalette.tsx`,
`client/palette.ts`, `api/forgeConversationClient.ts`). DAG canvas is real
(`components/project/DagCanvas.tsx`, `DagNodes/DagEdges/DagLegend/dagLayout.ts`).

**Not mounted** (render as `phase 3+` placeholders): `/roadmap` and `/personas`
remain `phase: "3+"` in `services/dashboard/src/app/routes.ts` and are absent
from `SCREEN_MOUNTS`.

---

# Set 1 — Hi-fi is BEHIND the implementation

These are real, mostly **purposeful** divergences where engineering built broader
adapter/configuration surfaces than the hi-fi depicts. Suggested hi-fi edits
follow each.

### 1.1 Secret-store backends — hi-fi shows only `vault://`

- **Hi-fi**: `view-settings.jsx` vault cards and `view-onboard-org.jsx` creds all
  use `vault://…` paths exclusively; the secret store is implicitly HashiCorp
  Vault.
- **Implementation**: `engine/contracts/secretStoreFactory.ts` selects among
  **vault · gcp_sm · aws_sm · onepassword · memory** via `TANREN_SECRET_STORE`
  (impls: `gcpSecretManager.ts`, `awsSecretsManager.ts`, `onePassword.ts`,
  `secretStore.ts`).
- **Why diverged**: purposeful — pluggable secret backends are an expansion seam.
- **Suggested hi-fi edit**: in org-setup step 2 (or settings vault panel), add a
  **secret-store backend selector** (Vault / GCP Secret Manager / AWS Secrets
  Manager / 1Password), and render vault refs as backend-neutral
  `secret://…` rather than always `vault://`.
- **Confidence: high.**

### 1.2 Allocators — hi-fi lists hetzner/DO/aws/k8s; impl adds GCP

- **Hi-fi**: `view-onboard-org.jsx` step 4 cloud allocators = **hetzner cloud,
  digitalocean, aws ec2, kubernetes pool** (+ local-docker default).
- **Implementation**: `engine/allocators/` ships `hetznerAllocator`,
  `digitalOceanAllocator`, `awsEc2Allocator`, `kubernetesAllocator`,
  `manualSshAllocator`, **`gcpAllocator`**, plus `staticRunnerAllocator` /
  `sidecarHttpAllocator` / `scaffoldedAllocators`.
- **Why diverged**: purposeful — GCP and manual-SSH are real allocator kinds.
- **Suggested hi-fi edit**: add **GCP Compute** to the cloud-allocator list, and a
  **manual SSH** entry (a bring-your-own host allocator) alongside local-docker.
- **Confidence: high.**

### 1.3 Provider BYOK-vs-managed toggle — absent from hi-fi

- **Hi-fi**: credentials step (`view-onboard-org.jsx` step 2) only models
  bring-your-own credentials (org API keys + dev bundles). No platform-managed
  provider concept.
- **Implementation**: `engine/config/managedProvider.ts` is an explicit
  `providerMode: "byok" | "managed"` seam — a managed OpenRouter-shell mode where
  every tenant runs against the platform's key and the platform meters/bills.
- **Why diverged**: purposeful (SaaS Tier-B seam). The OSS side is the toggle +
  endpoint plumbing; hosting owns the key/billing.
- **Suggested hi-fi edit**: add a credentials-step (or a hosting/settings)
  **provider-mode** control: "use my own keys (BYOK)" vs "use the managed
  provider", with a note that managed usage is metered/billed by the platform.
- **Confidence: high** (clearly a SaaS/hosting concern; **medium** on whether it
  belongs in the self-host hi-fi at all — flag for the user).

### 1.4 IdP — hi-fi is GitHub-only; impl adds OIDC/Authentik

- **Hi-fi**: `view-onboard-org.jsx` step 1 frames auth purely as the GitHub App
  install ("your github org is your tanren org").
- **Implementation**: `auth/oidcProvider.ts`, `auth/oidcEnv.ts`,
  `auth/authentikEnv.ts` alongside `auth/githubProvider.ts` — a generic OIDC /
  Authentik identity-provider path exists.
- **Why diverged**: purposeful — IdP abstraction is an expansion seam (memory:
  "clean adapter seams … IdPs").
- **Suggested hi-fi edit**: in org-setup auth, note that sign-in is GitHub **or**
  an OIDC IdP (Authentik), even if GitHub remains the recommended default.
- **Confidence: high** (code exists); **medium** on placement in the hi-fi.

### 1.5 GitHub App **install flow** — hi-fi shows the App but not the orchestrator-driven install

- **Hi-fi**: step 1 links to `github.com/apps/tanren/installations` (a static
  link).
- **Implementation**: `routes/auth/githubAppInstall.ts` +
  `engine/credentials/orgGithubApp.ts` +
  `engine/providers/githubAppTokenMinter.ts` provide an orchestrator-driven
  install that provisions an **auto-rotating installation token**; the dashboard
  wires `appInstallHref` when the canonical `TANREN_PUBLIC_BASE_URL` is set
  (`routes/onboarding/index.tsx`).
- **Why diverged**: purposeful — the App is the long-term connectivity model
  (memory: "GitHub App preferred connectivity").
- **Suggested hi-fi edit**: show the **two-path** auth (orchestrator-driven App
  install that mints rotating tokens, vs. the manual install link) and reflect the
  auto-rotating installation-token vault entry that already appears in settings.
- **Confidence: high.**

### 1.6 Tenancy / metering surface — exists in code, absent from hi-fi

- **Hi-fi**: budgets are modeled as a monthly **cost cap** only
  (`view-onboard-org.jsx` step 4, `view-costs.jsx`).
- **Implementation**: there is **no per-tenant quota policy layer** — the old
  `engine/quota/` (DB + no-op quota policies + metering export) was **deleted**;
  budget is the only admission gate (walker-enforced single $ ceiling). The read
  seam a hosting layer bills off moved to `engine/metering/index.ts`
  (`getOrgUsage` / `streamBillableRuns`, derived from `cost_records`).
- **Why diverged**: purposeful (SaaS metering seam) — but the gate is budget, not
  a quota table.
- **Suggested hi-fi edit**: if the hi-fi is to cover hosted/multi-tenant, add a
  **metering** surface (per-org usage export) distinct from the monthly cost cap.
  **Flag for the user** whether the vision hi-fi should depict hosting-tier
  concerns at all.
- **Confidence: medium** (clearly built; placement in a self-host vision is a
  judgment call).

### 1.7 Notification channels — hi-fi and impl are ALIGNED (no change)

- Recorded to prevent a false gap: hi-fi channels (slack, github checks, ntfy,
  teams, discord, email, sms·twilio, pagerduty, webhook) match
  `engine/notifications/channels/` 1:1. **No edit needed.**
- **Confidence: high.**

### 1.8 Merge integration — hi-fi and impl are ALIGNED (no change)

- The hi-fi review gate's four CTAs (native queue / direct merge / external
  reviewer / not configured) map exactly to
  `engine/workflow/reviewMerge/mergeDispatch.ts`
  (`native_queue | direct_merge | external_reviewer | not_configured`). Mergify is
  removed; `native_queue` is the merge engine, so the hi-fi's merge-integration CTA
  reads **native queue**, not "mergify queue". The per-repo `mergeIntegration` tweak
  is already in the hi-fi.
- **Confidence: high.**

### 1.9 Governance posture — hi-fi brownfield has a picker; impl has the behavior

- **Hi-fi**: brownfield onboarding includes a governance picker (chat2/chat3
  references; `view-onboard-existing.jsx`).
- **Implementation**: `engine/workflow/reviewMerge/governancePosture.ts`
  implements `strict | open | audit_only` as real merge-time behavior (external
  commits block / coexist / observe). The enum + behavior are richer than the
  hi-fi copy.
- **Why diverged**: purposeful — posture is wired into the merge decision.
- **Suggested hi-fi edit**: make the brownfield governance picker's three modes
  read **strict / open / audit-only** with the implemented semantics (external
  commit → block / coexist / observe), so the copy matches the shipped behavior.
- **Confidence: medium** (behavior is clearly built; exact hi-fi copy delta is a
  wording change).

### 1.10 Former vision-changes running-log — all "open" deltas already applied

For the record (folding the old running-log in): every "open vision change" it
listed — drop Wafer from routing/vault, per-repo merge CTAs, brownfield
`config.yaml` → `PROJECT.md` one-time snapshot, settings audit-gate-conditional
caption + subtitle — was **already applied to the hi-fi** in the chat3 session
(see `tanren-hi-fidelity/chats/chat3.md` and the current `view-settings.jsx` /
`view-onboard-existing.jsx` / `view-review.jsx`). Those items are **done**; do not
treat them as open work.
**Confidence: high.**

---

# Resolved since the prior audit

These were previously tracked as implementation-behind-hi-fi gaps. Current
`main` has shipped or verified them, so they are no longer Set 2 work.

### R.1 Forge in-conversation write-action approval — shipped

- **Hi-fi**: `shared.jsx` `ForgePalette` chat mode renders **action cards** that
  act mid-conversation; the design intent (chat1/chat4) is Forge that can
  _propose → operator confirms → execute_ inside the thread.
- **Implementation**: the safe **propose → approve → execute** pattern is live.
  `engine/answerers/schemas/forge.ts` allows `proposedActions`, the conversation
  engine persists pending proposals in `forge_action_proposals`, and
  `routes/forge/proposals.ts` re-validates + authz-checks approve/reject decisions
  before executing writes. The dashboard palette cards render approve/reject and
  executed/rejected/failed states (`client/paletteChat.ts`, `client/palette.ts`).
- **Remaining follow-up**: the proposed-tool set is intentionally limited to the
  existing write tools (`tanren.create_spec`, `tanren.trigger_run`,
  `tanren.rerun_task`, `tanren.acknowledge_insight`). Broadening it is future
  product work, not a missing hi-fi baseline.
- **Confidence: high.**

### R.2 Overview (org command deck) — mostly shipped

- **Hi-fi**: `view-org.jsx` `OverviewView` — projects grid, budget MTD, forge-org
  card, activity feed.
- **Implementation**: `/overview` is now `phase: "2b"` and mounted via
  `mountOverviewScreen` in `services/dashboard/src/app/screens.ts`. The route
  (`routes/overview/index.tsx`) renders the org command deck backed by
  `components/overview/*`, including project rows, MTD budget state, and
  cross-project activity.
- **Remaining gap**: the mounted `ForgeOrgCard` still renders the org-wide Forge
  affordance as unavailable because there is no org-wide Forge API yet. Tracked in
  Set 2 below.
- **Confidence: high for the mounted command deck; high that org-wide Forge
  remains missing.**

### R.3 Nav model cleanup — shipped

- **Hi-fi**: chat4 split nav into **org / projects / system** and pulled
  one-time onboarding routes out of standing product nav.
- **Implementation**: `services/dashboard/src/app/routes.ts` now uses the three
  standing groups **org / projects / system**. Onboarding routes still mount, but
  they are no longer permanent sidenav rows.
- **Confidence: high.**

### R.4 Spec full-page depth — run/economics depth verified

- **Hi-fi**: `view-spec.jsx` full page shows BDD acceptance, dependencies,
  blocked reason, run history, economics, and contextual "ask Forge" controls for
  the spec.
- **Implementation**: `components/project/SpecDrawer.tsx` now documents and
  renders the full-depth spec page. Tests pin BDD acceptance, dependency chain,
  run history, spend/attempt/average economics, and unavailable/unpriced handling
  (`services/dashboard/tests/projectDag.render.test.ts`).
- **Remaining gap**: the spec-scoped Forge action card/chips from the hi-fi are
  not present in the mounted spec page. Tracked in Set 2 below.
- **Confidence: high for run-history/economics depth; high that spec-scoped Forge
  remains missing.**

### R.5 Notifications delivery history + org-target quiet posture — shipped

- **Hi-fi**: `view-org.jsx` `NotificationsView` shows channel list, per-event
  matrix, delivery history, and pause/quiet-hours controls.
- **Implementation**: `/notifications` reads the org delivery ledger
  (`GET /orgs/:orgId/notifications/deliveries`) and renders delivery history.
  `NotificationsBody` also renders target-level pause/resume and weekend-mute
  controls, with POST proxies through `/notifications/targets/update`.
- **Remaining gap**: the hi-fi's personal pause/deep-work mode and local
  quiet-hours controls are not implemented by the org-target controls. Tracked in
  Set 2 below.
- **Confidence: high for shipped delivery history and org-target quiet posture;
  high that personal quiet hours remain missing.**

---

# Set 2 — Implementation is BEHIND the hi-fi

Real surfaces/flows the hi-fi specifies that the code does not yet (fully) build.

### 2.1 Overview org-wide Forge card — unavailable

- **Hi-fi**: `view-org.jsx` `OverviewView` includes a forge-org card for asking
  Forge across all projects.
- **Code state — PARTIAL**: `/overview` is mounted, but `ForgeOrgCard` renders the
  org-wide Forge affordance as unavailable because the backing org-wide Forge API
  does not exist yet.
- **Gap**: add the org-wide Forge read surface/API, then wire the overview card's
  prompt chips to it.
- **Size/priority: small / medium.**
- **Confidence: high.**

### 2.2 Spec-scoped Forge action card — missing

- **Hi-fi**: `view-spec.jsx` shows a contextual "ask Forge · this spec" card and
  prompt chips on the full spec page.
- **Code state — PARTIAL**: `SpecPageBody` renders description, blocked state,
  BDD, dependencies, run history, and economics, but not the spec-scoped Forge
  card/chips.
- **Gap**: add the spec-context Forge affordance to the full spec page and bind it
  to the existing Forge entrypoint with the selected spec context.
- **Size/priority: small / low.**
- **Confidence: high.**

### 2.3 Personal notification pause / quiet hours — missing

- **Hi-fi**: `view-org.jsx` `NotificationsView` includes personal channels,
  "pause · deep work mode" with auto-resume, and local quiet-hours controls under
  "what tanren tells you".
- **Code state — PARTIAL**: `/notifications` has org-scoped delivery history and
  target-level pause/weekend-mute controls, but no per-user pause/deep-work model
  or local quiet-hours persistence surface.
- **Gap**: add the personal notification posture model/API, then wire the
  personal pause and local quiet-hours controls in the notifications UI.
- **Size/priority: small / low.**
- **Confidence: high.**

### 2.4 Roadmap (cross-project Gantt) — placeholder only

- **Hi-fi**: `view-org.jsx` `RoadmapView` — cross-project Gantt-style timeline +
  upcoming-30d.
- **Code state — MISSING**: `/roadmap` is `phase: "3+"`, not in `SCREEN_MOUNTS`.
- **Size/priority: medium / low.**
- **Confidence: high.**

### 2.5 Personas (cross-project people-models) — placeholder only

- **Hi-fi**: `view-org.jsx` `PersonasView` — cross-project persona models with
  behaviors.
- **Code state — MISSING**: `/personas` is `phase: "3+"`, not in `SCREEN_MOUNTS`.
  (The persona _entity_ exists in the engine entity model, but no org-level
  surface.)
- **Size/priority: medium / low.**
- **Confidence: high.**

---

## Ambiguities / could not fully resolve

- **1.3 / 1.6 (managed provider, quota)** — clearly built as **hosting/SaaS-tier**
  seams. Whether the _vision_ hi-fi (explicitly a self-host-leaning product
  vision) should depict hosting-tier surfaces at all is a product call for the
  user, not a code fact. Flagged rather than asserted.
- **DORA** — `/dora` is mounted (P3-0019, `routes/dora/index.tsx`) and the hi-fi
  `DoraView` exists; I did not diff tile-by-tile but both sides are present, so no
  Set-2 item is raised for it.
