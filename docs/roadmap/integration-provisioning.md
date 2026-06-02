# Integration provisioning — the build plan

**Design of record:** `docs/operator-guide/integration-provisioning.md` (the boundary
model, the per-integration matrix, the Sentry concrete flow). This doc is the
**build sequencing** — the contract shape, PR-sized units + dependencies, and the
open decisions — that turns that design into merged code.

## The promise

An operator grants **high-level org/workspace/account access once** (a Sentry org
token, a Slack app, a Hetzner project token, a Vercel team token, the GitHub App
install). From that grant, Tanren **provisions, discovers, and binds every
project-level leaf resource itself** — never asking the operator to hand-create a
Sentry project, a Slack channel, an SSH key, a deploy app, or a webhook. Manual
entry survives only as a fallback for providers with no provisioning API or that
require interactive workspace-owner consent, and then with an in-product
explainer and a deep link, not a copy-paste prerequisite.

## Greenfield vs brownfield — the uniform rule

The same `IntegrationProvisioner` port serves both; the onboarding flow picks the
verb:

- **Greenfield** (Tanren builds the product from scratch): when a capability is
  enabled, **provision** — create the leaf resource (Sentry project, Slack
  channel, Fly app) under the org grant and bind it to the Tanren project.
- **Brownfield** (an existing repo is imported): **discover** the org's existing
  resources and either **bind** to the one the operator selects, or **provision** a
  new one if they weren't using that integration yet. Importing a repo that already
  has a Sentry project links it; one that doesn't gets a freshly-created project,
  wired the same way.

Both paths converge on the same `ProvisionedArtifact` (the project-level config +
the managed-secret refs + the inbox-source / notification-target to create).

## The seam (the keystone contract)

`engine/contracts/integrationProvisioner.ts` — one port every provider implements,
behind a registry (like `Allocator` / `VcsProvider` / `Repositories`), with a
conformance suite:

```
IntegrationProvisioner (project-INTEGRATION providers only — per provider kind:
                        sentry | slack | linear | jira | deploy.vercel | deploy.flyio | …;
                        cloud-allocator SSH/host-key automation is NOT this port — it
                        extends the Allocator seam, see P-INT-5)
  capability(): the capability id(s) this provisioner satisfies (e.g. "errors", "notify", "deploy")
  discover(orgGrant): ExistingResource[]        // brownfield: list what the org already has
  provision(orgGrant, projectCtx): ProvisionedArtifact   // greenfield / create-if-absent (idempotent find-or-create)
  bind(orgGrant, existingResourceId, projectCtx): ProvisionedArtifact   // brownfield link
  teardown(artifact)?                           // best-effort cleanup (project delete / unlink)
```

- **`orgGrant`** resolves from the **`org_integrations`** registry (below) → the
  managed credential ref + non-secret org metadata (Sentry org slug, Slack
  workspace id, Hetzner project, Vercel team).
- **`projectCtx`** carries the Tanren project + the discovered stack/platform (so
  the provisioner can pick the right Sentry platform, the right Fly region, etc.).
- **`ProvisionedArtifact`** = `{ projectConfig (non-secret, → projects.config),
secretRefs (→ secret manager), inboxSource?, notificationTarget?, deployRef? }`.
- **Idempotency is mandatory:** `provision` is find-or-create keyed on a stable
  name (re-running onboarding never creates a second Sentry project / Slack
  channel). This mirrors the merge-queue / post-merge-claim atomic-claim pattern.

`provision`/`bind`/`teardown` are **Writers against an external API** (they mutate
the provider), distinct from the existing runtime **poll/send adapters**
(`inbox/*Connector`, `notifications/channels/*`) which stay read/deliver-only. A
provisioner creates the artifact; the runtime adapter then uses it.

## The registry

`org_integrations` — a new org-scoped surface (table under RLS, or a structured
`organizations.config.integrations` sub-object; **decision O-1**), one row per
(org, provider): the provider kind, the managed-credential ref for the org grant,
non-secret org metadata, the enabled capabilities, and provisioning status. This
is the single place onboarding reads to know "does this org have Sentry?" and to
resolve the grant. Read/written through the `Repositories` seam.

## Build sequence (PR-sized units)

```
P-INT-0  org_integrations registry (surface + repository + RLS) + the
         IntegrationProvisioner port contract + registry + conformance.   [keystone]
         No provider impl yet — proves the seam with the in-memory fake.

P-INT-1  Sentry provisioner (the concrete model, §"Sentry concrete model"):
         discover/list org projects; provision = find-or-create project under the
         team + create client key/DSN; bind = link existing; emit the DSN as a
         project secret + create the inbox_source. Provisioning scopes documented.   → P-INT-0

P-INT-2  Onboarding/greenfield/brownfield rework: the flow requests CAPABILITIES
         ("enable error tracking", "notify on Slack", "deploy") not leaf secrets;
         each capability resolves a provisioner → discover(brownfield)/provision
         (greenfield) → bind → store the artifact. Manual fallback only where no
         API exists, with explainer + deep link.   → P-INT-1

P-INT-3  Slack provisioner: app/bot install, create/select channel (API-permitting),
         store webhook-or-bot artifact; both the notify channel AND the
         apex-product project secret.   → P-INT-0, P-INT-2

P-INT-4  Deploy provisioners (Vercel + Fly): create app/project, attach env vars,
         store preview-URL pattern + deployment ref → the live-preview-deploy
         surface (also unblocks apex P3b).   → P-INT-0, P-INT-2

P-INT-5  Cloud allocator provisioning — an EXTENSION of the Allocator seam (NOT
         IntegrationProvisioner): Hetzner first, then DO — create/import ephemeral
         per-run SSH key, inject runner cloud-init, pin host key (baked image or
         generated known_hosts) — removes the manual sshKeys + fingerprint.   → existing Allocator seam

P-INT-6  Outbound webhook signing + a webhook destination provision/test flow
         (the generic webhook channel currently doesn't sign; Sentry/GitHub
         service hooks Tanren creates need a per-source secret + verify).   → P-INT-1

P-INT-7  Linear / Jira / PagerDuty / Discord / Teams / Twilio provisioners
         (discover-or-create), per the matrix; lower priority, manual-fallback OK.   → P-INT-2

P-INT-8  Validation asserts CREATED artifacts: the e2e/validation suite + the
         connections manifest move P0/P1 to org grants and ASSERT Tanren created
         the Sentry project / Slack channel / deploy app at run time, rather than
         consuming pre-built leaf config (§8b extension).   → P-INT-1..5
```

`P-INT-0` is the keystone (everything attaches to it). `P-INT-1` (Sentry) proves
the full pattern end-to-end. `P-INT-4` (deploy) and `P-INT-5` (cloud SSH) directly
unblock `apex` (the deploy surface + real runner provisioning), so they sequence
ahead of Phase 3 where they overlap.

## Plane B — the built project's app environment (P-APP-ENV)

A **distinct** track from the Plane-A provisioner work above (see
`docs/operator-guide/integration-provisioning.md` → "Two distinct planes"). Plane A
is the integrations **Tanren** uses; Plane B is the env vars + secrets the **product
Tanren builds** needs — which may have zero overlap (the app sends email via Resend;
Tanren has no Resend integration). BYO is the default; provisioner-backed is an
enhancement where Tanren happens to have a provisioner for what the app wants. The
same provider can serve both planes for different consumers (Tanren's own Slack vs.
the apex product's Slack bot) and stays separate.

```
P-APP-ENV-0  Project App Environment store: a per-project `project_app_env` surface
             (key · value(secret→secret-manager | plain) · scopes[build|test|runtime|dev]
             · source[byo|provisioned]), RLS, repository. + dev/test materialization:
             the run workspace (over the runner) gets the dev+test app env so the
             building agent can run + test the app it writes (resolved from the App
             Environment store, NOT Tanren's provider creds; never logged).   [foundation, apex-needed]

P-APP-ENV-1  CI secret propagation: push the test-scoped app env to the target repo's
             Actions secrets via a new `VcsProvider.setActionsSecret`, so the
             project's `tanren-ci.yml` tests that need `RESEND_API_KEY` pass.   → P-APP-ENV-0

P-APP-ENV-2  Runtime injection: the deploy provisioner (P-INT-4) attaches the
             runtime-scoped app env as the DEPLOYED app's environment (Vercel/Fly).   → P-APP-ENV-0, P-INT-4

P-APP-ENV-3  Provisioner-backed app integrations: where Tanren has an
             `IntegrationProvisioner`, "enable <X> for the app" provisions the app's
             own resource and injects its secret as a Plane-B app env var (artifact
             lands in the App Environment, not org_integrations).   → P-INT-1, P-APP-ENV-0
```

`P-APP-ENV-0` is a foundation sibling to `P-INT-0` — both are early, both are
required by `apex` (the apex product's Slack bot token + any app env are Plane B,
configured + injected distinctly from Tanren's own Slack).

## Decisions (resolved 2026-06-02)

- **O-1 registry storage → dedicated `org_integrations` table** (RLS, per-row
  provisioning status, the join target for `inbox_sources` / notification targets).
  Migration lives in P-INT-0.
- **O-2 provider order → all four apex-relevant providers in parallel** after the
  foundation (Sentry · Deploy Fly/Vercel · Cloud-SSH Hetzner · Slack), one PR each,
  like the Phase-1 wave. They write project artifacts to **existing** surfaces
  (`projects.config` JSONB · `inbox_sources` · notification targets · secret
  manager) so they are **migration-free** and parallelize without collision; only
  P-INT-0 adds schema.
- **O-3 auto-provision → confirm-with-smart-default.** Greenfield auto-creates with
  a one-click confirm; brownfield defaults to "bind the discovered match" else
  "create new"; the operator can always override. The `IntegrationProvisioner`
  surfaces `discover()` so onboarding can show the smart default.
- **O-4 sequencing → foundation + apex-relevant providers first**, then `apex` runs
  on the real provisioned (not hand-built) path (apex is the proof of the provisioner
  model too). Deploy + Cloud-SSH directly unblock the apex deploy surface + real
  runner provisioning.
