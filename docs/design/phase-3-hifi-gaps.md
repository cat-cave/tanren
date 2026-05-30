# Hi-fi ↔ Implementation Audit

**Dated 2026-05-29.** This is a from-scratch, evidence-grounded audit of the
locally-installed hi-fidelity design bundle (`tanren-hi-fidelity/`) against the
current codebase on `main`. It **replaces** the previous "Phase 3 Hi-Fi Design
Gaps" content and folds in the stale `hifi-vision-changes.md` notes (whose "open"
deltas were all already applied to the hi-fi — see chat3 transcript).

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
audits. The ⌘K Forge palette + thick-Forge chat morph ships
(`components/palette/ForgePalette.tsx`, `client/palette.ts`,
`api/forgeConversationClient.ts`). DAG canvas is real
(`components/project/DagCanvas.tsx`, `DagNodes/DagEdges/DagLegend/dagLayout.ts`).

**Not mounted** (render as `phase 3+` placeholders): `/overview`, `/roadmap`,
`/personas` — they remain `phase: "3+"` in `services/dashboard/src/app/routes.ts`
and are absent from `SCREEN_MOUNTS`.

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
  `engine/credentials/orgGithubApp.ts` / `githubAppTokenMinter.ts` provide an
  orchestrator-driven install that provisions an **auto-rotating installation
  token**; the dashboard wires `appInstallHref` when
  `TANREN_ORCHESTRATOR_PUBLIC_URL` is set
  (`routes/onboarding/index.tsx`).
- **Why diverged**: purposeful — the App is the long-term connectivity model
  (memory: "GitHub App preferred connectivity").
- **Suggested hi-fi edit**: show the **two-path** auth (orchestrator-driven App
  install that mints rotating tokens, vs. the manual install link) and reflect the
  auto-rotating installation-token vault entry that already appears in settings.
- **Confidence: high.**

### 1.6 Tenancy / quota surface — exists in code, absent from hi-fi

- **Hi-fi**: budgets are modeled as a monthly **cost cap** only
  (`view-onboard-org.jsx` step 4, `view-costs.jsx`). No tenant-quota concept.
- **Implementation**: `engine/quota/` (`dbPolicy.ts`, `noopPolicy.ts`,
  `meteringExport.ts`, `contracts.ts`) is a per-tenant quota/metering policy
  layer.
- **Why diverged**: purposeful (SaaS multi-tenant seam).
- **Suggested hi-fi edit**: if the hi-fi is to cover hosted/multi-tenant, add a
  **quota/metering** surface (per-org limits + metering export) distinct from the
  monthly cost cap. **Flag for the user** whether the vision hi-fi should depict
  hosting-tier concerns at all.
- **Confidence: medium** (clearly built; placement in a self-host vision is a
  judgment call).

### 1.7 Notification channels — hi-fi and impl are ALIGNED (no change)

- Recorded to prevent a false gap: hi-fi channels (slack, github checks, ntfy,
  teams, discord, email, sms·twilio, pagerduty, webhook) match
  `engine/notifications/channels/` 1:1. **No edit needed.**
- **Confidence: high.**

### 1.8 Merge integration — hi-fi and impl are ALIGNED (no change)

- The hi-fi review gate's four CTAs (mergify queue / direct merge / external
  reviewer / not configured) map exactly to
  `engine/workflow/reviewMerge/mergeDispatch.ts`
  (`mergify_queue | direct_merge | external_reviewer | not_configured`). The
  per-repo `mergeIntegration` tweak (chat3) is already in the hi-fi. **No edit
  needed**, and the stale `hifi-vision-changes.md` "make merge CTAs conditional"
  item is **DONE** (chat3).
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

### 1.10 Stale `hifi-vision-changes.md` — all "open" deltas already applied

For the record (folding the old doc in): every "open vision change" listed in the
former `hifi-vision-changes.md` — drop Wafer from routing/vault, per-repo merge
CTAs, brownfield `config.yaml` → `PROJECT.md` one-time snapshot, settings audit-
gate-conditional caption + subtitle — was **already applied to the hi-fi** in the
chat3 session (see `tanren-hi-fidelity/chats/chat3.md` and the current
`view-settings.jsx` / `view-onboard-existing.jsx` / `view-review.jsx`). That doc
is therefore **superseded**; do not treat its items as open work.
**Confidence: high.**

---

# Set 2 — Implementation is BEHIND the hi-fi

Real surfaces/flows the hi-fi specifies that the code does not yet (fully) build.

### 2.1 Forge **in-conversation write-action approval** — RESOLVED / IN-REVIEW (was the single biggest gap)

- **Hi-fi**: `shared.jsx` `ForgePalette` chat mode renders **action cards** that
  act mid-conversation; the design intent (chat1/chat4) is Forge that can _propose
  → operator confirms → execute_ inside the thread. The hi-fi also shows write
  affordances throughout (create spec, trigger run, etc.).
- **Resolved (in PR review — `feat/forge-write-action-approval`)**: implemented the
  safe **propose → approve → execute** pattern. The model never executes a write;
  a human approves it and the write runs under the **approving operator's** authz.
  - The Forge answerer's final `ForgeAnswer` may carry optional `proposedActions`
    (`engine/answerers/schemas/forge.ts`); the conversation engine
    (`engine/forge/conversation/engine.ts`) no longer drops these — it persists
    each as a **pending** `forge_action_proposals` row (new migration
    `0028_massive_callisto.sql`, `db/src/schemaForge.ts`; org*id NOT NULL +
    indexed per the 0026 tenancy pattern). Read-tool behavior is unchanged; mid-
    loop write-tool \_dispatch* is still dropped.
  - Approve/reject routes (`routes/forge/proposals.ts`) re-validate + authz the
    deciding operator against the underlying write (reusing
    `engine/forge/tools/write.ts`), execute it, append a forge turn, and advance
    the proposal to `executed`/`failed`/`rejected`. Decisions are **idempotent** —
    an already-decided proposal returns a typed **409**, never double-executing.
  - The dashboard palette write-action cards are now **LIVE**
    (`client/paletteChat.ts` + `client/palette.ts`): pending proposals render
    approve/reject controls that POST to a same-origin BFF proxy
    (`/forge/proposals/{approve,reject}` in `main.tsx`) and show
    executed/rejected/failed states. (The old INERT-card path is removed.)
  - **Tools the model may propose**: the existing four write tools
    (`tanren.create_spec`, `tanren.trigger_run`, `tanren.rerun_task`,
    `tanren.acknowledge_insight`).
- **Remaining (for the human reviewer to confirm)**: that proposed-tool set
  starts at exactly those four; broadening it is a follow-up.
- **Confidence: high.**

### 2.2 Overview (org command deck) — placeholder only

- **Hi-fi**: `view-org.jsx` `OverviewView` — projects grid, budget MTD, forge-org
  card, activity feed.
- **Code state — MISSING**: `/overview` is `phase: "3+"` in
  `app/routes.ts` and absent from `SCREEN_MOUNTS`; it renders the documented
  placeholder.
- **Size/priority: medium / medium.**
- **Confidence: high.**

### 2.3 Roadmap (cross-project Gantt) — placeholder only

- **Hi-fi**: `view-org.jsx` `RoadmapView` — cross-project Gantt-style timeline +
  upcoming-30d.
- **Code state — MISSING**: `/roadmap` is `phase: "3+"`, not in `SCREEN_MOUNTS`.
- **Size/priority: medium / low.**
- **Confidence: high.**

### 2.4 Personas (cross-project people-models) — placeholder only

- **Hi-fi**: `view-org.jsx` `PersonasView` — cross-project persona models with
  behaviors.
- **Code state — MISSING**: `/personas` is `phase: "3+"`, not in `SCREEN_MOUNTS`.
  (The persona _entity_ exists in the engine entity model, but no org-level
  surface.)
- **Size/priority: medium / low.**
- **Confidence: high.**

### 2.5 Nav model not cleaned up to the hi-fi's realistic-product nav

- **Hi-fi**: chat4 deliberately split nav into **org / projects / system** and
  **pulled onboarding OUT of standing nav** (onboarding is a once-per-org first-
  run flow, reachable only from Tweaks "all flows" / Overview buttons — see
  `app.jsx` `ONBOARDING_ROUTES` comment and `shared.jsx` `SideNav`).
- **Code state — DIVERGENT**: the dashboard nav (`app/routes.ts` `NAV_GROUPS`,
  `components/shell/SideNav.tsx`) still has **four groups org / projects / set up /
  onboarding** with **onboarding as standing nav**. Group label is "set up" not
  "system".
- **Gap**: pull the onboarding group out of the product sidebar (keep the routes,
  reach them from onboarding entry points), and reconcile the "set up"→"system"
  grouping. Note this is a deliberate _later_ hi-fi decision; the dashboard nav
  predates it.
- **Size/priority: small / medium.**
- **Confidence: high.**

### 2.6 Spec full-page depth — verify against the hi-fi's run-history/economics

- **Hi-fi**: `view-spec.jsx` full page shows run history, dependency chains,
  economics, BDD acceptance, blocked-reason, contextual "ask forge".
- **Code state — PARTIAL (verify)**: `routes/projects/specRoutes.tsx` ships both
  `/specs/:id/drawer` and `/specs/:id` full page (156 lines), but is noticeably
  thinner than the hi-fi (few references to economics/run-history in the file).
  The drawer + full-page **escalation exists**; the depth of run-history /
  economics panels may be partial.
- **Gap**: confirm and, if needed, fill run-history + economics panels on the full
  spec page.
- **Size/priority: small / low.**
- **Confidence: medium** (route exists; panel completeness not fully verified).

### 2.7 Notifications — delivery history + quiet hours (verify)

- **Hi-fi**: `view-org.jsx` `NotificationsView` shows the channel list + per-event
  matrix **plus delivery history and pause/quiet-hours**.
- **Code state — PARTIAL**: `/notifications` is mounted
  (`routes/onboarding/index.tsx`) and renders the channels + per-event × severity
  matrix (`components/onboarding/NotificationsBody`), but **delivery history** and
  **quiet-hours/pause** are not evidently present.
- **Gap**: add the delivery-history list and quiet-hours/pause controls.
- **Size/priority: small / low.**
- **Confidence: medium.**

---

## Ambiguities / could not fully resolve

- **1.3 / 1.6 (managed provider, quota)** — clearly built as **hosting/SaaS-tier**
  seams. Whether the _vision_ hi-fi (explicitly a self-host-leaning product
  vision) should depict hosting-tier surfaces at all is a product call for the
  user, not a code fact. Flagged rather than asserted.
- **2.6 / 2.7** — the routes exist; I confirmed the _files_ but not every rendered
  panel pixel-for-pixel against the hi-fi. Marked medium and called "verify".
- **DORA** — `/dora` is mounted (P3-0019, `routes/dora/index.tsx`) and the hi-fi
  `DoraView` exists; I did not diff tile-by-tile but both sides are present, so no
  Set-2 item is raised for it.
