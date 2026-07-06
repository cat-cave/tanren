# Hi-fi work-needed catalog

A standing, code-grounded work-list **for the in-repo hi-fi prototype**
(`tanren-hi-fidelity/`) — the hand-done design reference for **Tanren's OWN
dashboard**. It catalogs everywhere the frozen hi-fi is either **missing** a feature
the built product now has, has **drifted** from built reality, or carries a
**hi-fi-only** vision that has no code counterpart (so the revision should keep, not
"build", it). The intended consumer is **a design tool** (Claude Design /
claude.ai/design): this doc is taken into that tool to revise the hi-fi bundle and
produce its next version.

> **Not to be confused with the native design subsystem.** This catalog is about
> revising the human reference for Tanren's dashboard. The way Tanren designs the
> apps it _builds_ — the native, in-DAG design pipeline (`DesignContract` → design
> agent/phase → writer injection → design oracle) — is a separate, now-built
> concern; see `docs/roadmap/native-design-subsystem.md`. Items below are hi-fi
> bundle edits, not specs for that subsystem.

## Relationship to the two existing design docs

This is the **inverse-direction artifact** of the existing audit. It does not
restate either of these — it references and builds on them:

- **`docs/design/phase-3-hifi-gaps.md`** — the mature hi-fi ↔ code gap **audit**
  (Set 1 = hi-fi-behind-code → user edits the hi-fi; Set 2 = code-behind-hi-fi →
  build work). That doc audits both directions of drift _for the implementation_.
  **This doc is the work-list _for the hi-fi bundle itself_**: it folds Set 1
  forward (every Set-1 delta is a thing the hi-fi must change), explicitly excludes
  Set 2 (that is build work, not hi-fi work), and adds the surfaces built
  _since_ the hi-fi froze that the audit's two-set framing does not foreground.
- **`docs/design/hifi-revision-process.md`** — the **SOP** for when a NEW revision
  arrives (import the bundle → read chats → re-audit from code → produce two sets →
  record deltas → file build work). This doc is an _input_ to that process: it is
  the pre-assembled catalog the next revision pass acts on. It does **not** replace
  the re-audit step — re-verify against code, per that doc's "audit from code, not
  from docs" principle.

## How the hi-fi froze (the baseline this catalogs against)

The hi-fi is `tanren-hi-fidelity/project/*.jsx`: a router/shell (`app.jsx`,
`shared.jsx` nav + `ForgePalette`, `flows.jsx`), the data mocks (`data.jsx`,
`data-gaps.jsx`), and 16 `view-*` screens. Its last design pass (`chats/chat4.md`)
closed five gaps — thick Forge thread, spec drawer/page, tanren-config audit gate,
scheduled audits, candidate inbox — and did a nav cleanup (org / projects / system;
onboarding pulled out of standing nav). It is an explicit **phase-agnostic vision**
(chat4: "a vision of what we want the product to be, NOT … tied to any specific
phase"). The product has since shipped four large surface families the hi-fi never
saw (§1), plus a set of adapter/config breadth deltas the audit already catalogs
as Set 1 (§2).

## How to read an entry

Each entry names: **hi-fi source** (screen/file, or "none — absent"), **built code
path** (if any), **gap type** (`missing` / `drifted` / `dropped`), and a one-line
**what the new hi-fi should do**.

---

# §1 — Surfaces built since the hi-fi froze, ABSENT from it

The meatiest section. These are whole feature families the product built _after_
the hi-fi's last pass. None of them is mounted in the hi-fi **or** in the dashboard
yet (verified: `services/dashboard/src/app/screens.ts` mounts none of templating /
integrations / merge-queue) — so they are pure "the design vision must catch up to
the engine" work, not build-debt. For each: what the hi-fi lacks + the built
surface it should reflect.

### 1.1 Tanren-native templating — fragment library + per-fragment authoring runs

- **Hi-fi source**: none — entirely absent. The hi-fi onboarding (`view-onboard-new.jsx`,
  `view-onboard-existing.jsx`) treats scaffolding as an implicit per-run derivation;
  there is no fragment, library, or authoring-run concept anywhere.
- **Built code path**: the doctrine has collapsed to **fragments as the SINGLE
  primitive** — there is no template registry, no `.tanren/template.yml` manifest,
  no `lts | nightly` channels, no template-creation meta-DAG, and no
  template-maintenance scheduler. The core library ships as bundled fragments
  (`engine/templates/fragments/library/` — `base`, `runtime-node-pnpm`,
  `runtime-ruby-bundler`, `frontend-react-router`, `frontend-remix`,
  `db-postgres-prisma`, `deploy-fly`, `deploy-none`, `addon-biome`, `addon-docker`),
  overlaid at derive time with per-org fragments from the `fragments` table
  (`engine/templates/fragments/unifiedLibrary.ts`). Per-project seeding runs
  `selectFragmentConfig` against that unified library — on a miss, the
  per-fragment authoring DAG (F2 — `routes/onboarding/fragmentAuthoring.ts` +
  `engine/templates/fragments/providerFragmentAuthorer.ts` +
  `fragmentAuthoringRun.ts`) authors the missing fragment via a real LLM,
  smoke-composes it, and persists it to `fragments` (status `draft` →
  `validated`); on a fixed-point failure the derive halts loud
  (`FragmentAuthoringFailedError` → 409 `fragment_authoring_failed`). The
  composed VFS materializes directly into the project repo — there is no
  intermediate `tanren-tmpl-<slug>` seed repo (PR-G). Lifecycle events:
  `fragment.authoring.{started,succeeded,failed}` in
  `engine/events/schemas/templates.ts`. Doctrine:
  `docs/roadmap/templating-system.md`.
- **Gap type**: `missing`.
- **What the new hi-fi should do**: add a **fragment library** surface (list of
  fragments by kind × label — the 9 compose phases and the per-kind labels; core
  vs. per-org overrides visible) and a **fragment-authoring run** surface (an F2
  run rendered in the same event timeline as writer runs, with `started` /
  `succeeded` / `failed` states and the latest rejection text on a fixed-point
  halt — the derive halts loud on `fragment_authoring_failed`, never a silent
  skip). Per-project seeding remains an implicit derivation from the captured
  lifecycle — no operator-picked stack, no template-selection step in
  onboarding.

### 1.2 Apex run-rhythm + the dollar budget gate

- **Hi-fi source**: budget is modeled as a **monthly cost cap** only
  (`view-onboard-org.jsx` step 4; `view-costs.jsx`; `view-org.jsx` Overview
  "budget · month-to-date" card). There is no admission-gate / halt-on-budget
  concept, and no run-rhythm (teardown-and-rerun vs patch-and-continue) surface.
- **Built code path**: the budget gate is a real **walker admission gate**, not a
  display — `engine/dag/budgetGate.ts` (resolves project-over-org ceiling, sums
  cumulative `cost_records.cost_usd` over a `monthly | total` period, **pauses the
  tick** when the ceiling is reached) + `engine/workflow/budgetPreflight.ts`, read
  via `routes/projects/budget.ts`. The run-rhythm doctrine
  (teardown + fix-on-main + fresh run; a budget halt is a _finding_, not a thing to
  hand-patch) lives in `docs/operator-guide/apex.md` and
  `docs/roadmap/budget-model.md`.
- **Gap type**: `missing` (the cap exists; the gate semantics + halt state do not).
- **What the new hi-fi should do**: surface the budget as an **enforced ceiling**
  with a distinct **"halted on budget"** state (which specs stacked behind it, the
  "raise budget unblocks N specs" affordance the `data-gaps.jsx` `blocking_m5`
  Forge answer already gestures at), and depict the project/org **budget config
  knob** (period + ceiling, project-over-org) as a first-class control, not just a
  read-only MTD number.

### 1.3 Native merge queue · MergeAuthority · jj base-shift

- **Hi-fi source**: `view-review.jsx` review gate with four per-repo merge CTAs
  (`native queue` / direct merge / external reviewer / not configured) — this names
  the native queue but depicts merge as a **per-PR review handoff**, with no
  queue-coordination, no single merge-decision authority, and no rebase/base-shift
  surface.
- **Built code path**: the **`MergeAuthority`** is the sole, fail-closed merge
  decision (`engine/contracts/mergeAuthority.ts`, `engine/merge/mergeAuthority*.ts`
  — gate, inputs, bundle-build, land-finalizer); the **`integration_nodes`** run
  model (`engine/contracts/integrationNodes.ts`, `engine/dag/integrationNodesPg.ts`)
  is the unified merge-coordination model; the **never-discard
  `BaseShiftCoordinator`** (`engine/dag/baseShiftCoordinator*.ts`,
  `baseShiftLive*.ts`) jj-rebases dependent work in place instead of
  superseding+regenerating it. Doctrine:
  `docs/architecture/tanren-owns-the-engine.md` + `docs/architecture/autonomy-engine.md`.
- **Gap type**: `missing` (the review _gate_ exists; the queue/authority/base-shift
  machinery does not).
- **What the new hi-fi should do**: add a **merge-queue** surface (the queue of
  integration nodes the `MergeAuthority` is deciding, in order), make the merge
  decision read as **one authoritative fail-closed gate** (replacing the impression
  of scattered review/gate/mergeability checks), and surface **base-shift / rebase
  in place** when an ancestor merges — dependent work is _rebased_, never discarded.

### 1.4 Integration provisioning — the two-plane model (Sentry / Deploy / Slack / Hetzner)

- **Hi-fi source**: `view-onboard-org.jsx` (creds step + allocators step) and
  `view-inbox.jsx` (`INBOX_SOURCES` in `data-gaps.jsx` lists github/linear/sentry as
  hardcoded connectors). The hi-fi has **no notion of the org-grant plane** (link a
  provider once at the org) feeding a **per-project capability provisioning plane**
  (enable "error tracking" / "notify on Slack" / "deploy" for a project).
- **Built code path**: the two-plane model — **plane 1** the org grant registry
  (`org_integrations`, linked via `POST /:orgId/integrations/:providerKind` in
  `routes/integrations/index.ts`, token stored as a secret REF only) and **plane 2**
  the per-project capability engine (`engine/integrations/provisioningEngine.ts`:
  capability → provisioner, confirm-with-smart-default greenfield-create /
  brownfield-bind, persists over inbox-sources / notification-targets /
  projectConfig, emits `integration.provisioned` with refs only). Providers:
  Sentry (`engine/providers/sentryProvisioner.ts`), Deploy (Vercel/Fly —
  `engine/providers/{vercel,fly}DeployProvisioner.ts`, `provisioners/deployTransport.ts`),
  Slack (`engine/integrations/slack/slackProvisioner.ts`), and the Hetzner
  allocator family (`engine/allocators/hetznerAllocator`).
- **Gap type**: `missing`.
- **What the new hi-fi should do**: model onboarding as **link-provider-once
  (org) → enable-capability-per-project**, where enabling a capability the org
  hasn't linked shows a **"link <provider> first"** prompt (not a dead control),
  and where the four apex-relevant capabilities — error tracking (Sentry), deploy
  (Vercel/Fly), notify (Slack), allocate (Hetzner) — appear as enable-toggles that
  resolve to provisioned resources by reference (DSNs/channels/tokens never shown).

---

# §2 — Hi-fi screens DRIFTED from built reality

These are the **Set-1 deltas** from `phase-3-hifi-gaps.md` (hi-fi-behind-code),
folded forward as hi-fi work with the screen each lives on. See that doc for the
full evidence per item; this is the actionable index. (Its §1.7 notification
channels and §1.8 merge-integration CTAs are recorded there as **aligned, no
change** — excluded here. §1.10 is the already-applied running-log — excluded.)

### 2.1 Secret-store backends — hi-fi shows only `vault://`

- **Hi-fi source**: `view-settings.jsx` vault cards + `view-onboard-org.jsx` step 2
  creds, all `vault://…`. **Code**: `engine/contracts/secretStoreFactory.ts`
  (vault · gcp_sm · aws_sm · onepassword · memory). **Type**: `drifted`.
- **What the new hi-fi should do**: add a **secret-store backend selector** and
  render refs as backend-neutral `secret://…`, not always `vault://`.
  (See `phase-3-hifi-gaps.md` §1.1.)

### 2.2 Allocators — hi-fi lacks GCP + manual-SSH

- **Hi-fi source**: `view-onboard-org.jsx` step 4 (`hetzner` / `digitalocean` /
  `aws ec2` / `kubernetes pool` + local-docker). **Code**: `engine/allocators/`
  adds `gcpAllocator` and `manualSshAllocator`. **Type**: `drifted`.
- **What the new hi-fi should do**: add **GCP Compute** to the cloud-allocator list
  and a **manual SSH** (bring-your-own host) entry beside local-docker.
  (See `phase-3-hifi-gaps.md` §1.2.)

### 2.3 Provider BYOK-vs-managed toggle — absent

- **Hi-fi source**: `view-onboard-org.jsx` step 2 (BYOK keys only). **Code**:
  `engine/config/managedProvider.ts` (`providerMode: "byok" | "managed"`).
  **Type**: `drifted`.
- **What the new hi-fi should do**: add a **provider-mode** control ("my own keys"
  vs "managed provider, metered/billed by the platform"). _Flag_: whether a
  self-host-leaning vision should depict the hosted-tier toggle at all is a product
  call. (See `phase-3-hifi-gaps.md` §1.3 / §1.6.)

### 2.4 IdP — hi-fi is GitHub-only; code adds OIDC / Authentik

- **Hi-fi source**: `view-onboard-org.jsx` step 1 (GitHub App install only).
  **Code**: `auth/oidcProvider.ts`, `auth/authentikEnv.ts` beside
  `auth/githubProvider.ts`. **Type**: `drifted`.
- **What the new hi-fi should do**: note sign-in is GitHub **or** an OIDC IdP
  (Authentik), GitHub still the recommended default.
  (See `phase-3-hifi-gaps.md` §1.4.)

### 2.5 GitHub App install flow — hi-fi shows a static link, not the orchestrator-driven install

- **Hi-fi source**: `view-onboard-org.jsx` step 1 (static
  `github.com/apps/tanren/installations` link). **Code**:
  `routes/auth/githubAppInstall.ts` + `engine/credentials/orgGithubApp.ts` +
  `engine/providers/githubAppTokenMinter.ts` (orchestrator-driven install minting
  an auto-rotating installation token; `appInstallHref` wired in
  `routes/onboarding/index.tsx`). **Type**: `drifted`.
- **What the new hi-fi should do**: show the **two-path** auth (orchestrator-driven
  App install minting rotating tokens vs. the manual link) and the auto-rotating
  installation-token vault entry. (See `phase-3-hifi-gaps.md` §1.5.)

### 2.6 Governance posture — picker copy lags the implemented behavior

- **Hi-fi source**: `view-onboard-existing.jsx` brownfield governance picker.
  **Code**: `engine/workflow/reviewMerge/governancePosture.ts`
  (`strict | open | audit_only` = external commits block / coexist / observe).
  **Type**: `drifted`.
- **What the new hi-fi should do**: make the three modes read **strict / open /
  audit-only** with the shipped semantics (external commit → block / coexist /
  observe). (See `phase-3-hifi-gaps.md` §1.9.)

---

# §3 — Hi-fi-only vision with NO code counterpart (do NOT treat as build debt)

These exist only in the hi-fi and are **intentionally deferred** in the build
(`phase: "3+"` in `services/dashboard/src/app/routes.ts`, absent from
`SCREEN_MOUNTS`). They are flagged here so the design tool **keeps** them as vision
rather than reading them as "the hi-fi is ahead, go build it" — and equally does
not delete them. (These are the inverse of §1–§2: hi-fi-ahead, not hi-fi-behind.)

### 3.1 Overview — org command deck

- **Hi-fi source**: `view-org.jsx` `OverviewView` (projects grid, budget MTD,
  forge-org card, activity feed). **Code**: `/overview` is `phase: "3+"`,
  placeholder only. **Type**: `dropped` (hi-fi-only / deferred).
- **What the new hi-fi should do**: **keep** as the org command deck; mark it a
  vision surface ahead of code, not build debt.

### 3.2 Roadmap — cross-project Gantt

- **Hi-fi source**: `view-org.jsx` `RoadmapView` (cross-project timeline +
  upcoming-30d). **Code**: `/roadmap` is `phase: "3+"`, placeholder only.
  **Type**: `dropped` (hi-fi-only / deferred).
- **What the new hi-fi should do**: **keep** as a vision surface.

### 3.3 Personas — cross-project people-models

- **Hi-fi source**: `view-org.jsx` `PersonasView` (cross-project persona models).
  **Code**: `/personas` is `phase: "3+"`, placeholder only (the persona _entity_
  exists in the engine, but no org-level surface). **Type**: `dropped`
  (hi-fi-only / deferred).
- **What the new hi-fi should do**: **keep** as a vision surface.

> Note on Notifications (`view-org.jsx` `NotificationsView`) and the spec full-page
> depth (`view-spec.jsx`): these are **partial in code** (Set-2 build work in
> `phase-3-hifi-gaps.md` §2.6 / §2.7 — delivery-history + quiet-hours, run-history +
> economics panels), NOT hi-fi-only. They need **no hi-fi change**; the hi-fi
> already specifies them. Listed here only to disambiguate from the dropped trio.

---

# §4 — `data-gaps.jsx`-grounded surfaces: prototype intent vs shipped routes

The chat4 gap-closing pass built four surfaces off `data-gaps.jsx` mock data. Three
of those routes have since **shipped in the dashboard**, so the hi-fi mock should be
checked against built reality for drift (the surfaces themselves are aligned in
spirit; the deltas are in the configuration breadth around them).

### 4.1 Scheduled (cron) audits

- **Hi-fi source**: `view-audits.jsx` + `data-gaps.jsx` `AUDIT_JOBS` /
  `AUDIT_RECOMMENDED` (recurring Answerer passes filling idle subscription windows).
  **Code**: `audits` route is mounted (`screens.ts`). **Type**: `drifted` (verify).
- **What the new hi-fi should do**: keep the audits library; re-check the
  window-fill / forge-recommended-coverage copy against the shipped audits route
  (the audits store still issues raw SQL per `forge/audits/store.ts` — surface
  unaffected, but verify field shapes).

### 4.2 tanren-config audit-gate PR

- **Hi-fi source**: `view-config.jsx` + `data-gaps.jsx` `CONFIG_PR` (config-as-code
  PR review, gate on/off). **Code**: `config` route is mounted. **Type**: `drifted`
  (verify). **What the new hi-fi should do**: keep the config-PR diff/CI/merge-gate
  surface; verify the YAML config shape (role routing / limits) against the current
  config schema; the `mergeIntegration` default in the gate copy should read
  **native queue** (Mergify is removed).

### 4.3 Candidate inbox

- **Hi-fi source**: `view-inbox.jsx` + `data-gaps.jsx` `INBOX_SOURCES` / `CANDIDATES`
  (configurable issue sources → dedupe/match/placement triage; scheduled-audit
  findings auto-route). **Code**: `inbox` route is mounted (raw SQL in
  `forge/inbox/store.ts`). **Type**: `drifted`. **What the new hi-fi should do**:
  keep the configurable-sources triage; cross-wire it to the **§1.4 integration
  provisioning** model — an inbox source (Sentry, github-issues) is now a
  **provisioned capability** (`provisioningEngine.ts` persists `inboxSource` →
  `inbox_sources`), so "+ connect a source" should resolve through the org-grant /
  capability two-plane, not a free-form connector list.

---

# Summary

| §   | Axis                                                                     | Entries                                                                                    |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| §1  | Built-since-froze, absent from hi-fi (`missing`)                         | 4 (templating, budget/run-rhythm, merge-queue/authority/base-shift, integration two-plane) |
| §2  | Hi-fi drifted from build (`drifted`, folds `phase-3-hifi-gaps.md` Set 1) | 6 (secret-store, allocators, BYOK/managed, IdP, GitHub App install, governance posture)    |
| §3  | Hi-fi-only / dropped — keep as vision, not build debt                    | 3 (Overview, Roadmap, Personas)                                                            |
| §4  | `data-gaps.jsx` surfaces vs shipped routes (`drifted`/verify)            | 3 (cron audits, config-PR gate, candidate inbox)                                           |

**16 actionable entries.** §1 is the meatiest (whole new feature families); §2 is
the fold-forward of the existing audit's Set 1; §3 prevents the design tool from
mistaking deferred vision for build debt; §4 reconciles the chat4 gap-closing mocks
with the now-shipped routes. Re-verify every entry against code on the revision pass
(`hifi-revision-process.md`: audit from code, not from docs).
