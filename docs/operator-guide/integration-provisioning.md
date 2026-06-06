# Integration provisioning boundaries

> **Status — built (design-of-record).** The provisioner substrate is shipped:
> the `org_integrations` table + repo, the `IntegrationProvisioner` contract +
> registry, the Sentry / Slack / Fly / Vercel provisioners, the `hetznerAllocator`,
> and the per-project **App Environment** store
> (`engine/repositories/appEnvironment.ts` +
> `engine/workflow/{attachRuntimeAppEnv,resolveAppEnv}.ts`, injected over SSH by
> `engine/ssh/appEnvPrelude.ts`). This document is the durable **two-plane boundary
> model** that governs how those pieces fit together; the per-integration matrix
> below records the intended posture per provider (some rows still describe the
> least-privilege / discovery refinements that remain per provider). It is **not**
> a GitHub-Actions design — delivery is Action-less (see the `test`/gate note
> below).

Tanren integrations must start from an **org-level grant** whenever the upstream
platform allows it. Project-, repo-, channel-, phone-, or environment-specific
resources are Tanren-managed artifacts created from that grant during project
onboarding, greenfield generation, or notification setup. Operators should not
manually create those leaf resources as a prerequisite for every Tanren project.

This keeps greenfield projects viable: connecting Sentry, Slack, Hetzner, or a
deploy provider once at the org level must be enough for Tanren to create and
wire each new project.

## Two distinct planes (do not conflate)

There are **two separate kinds** of integration/secret, and they are configured,
stored, and injected differently:

- **Plane A — Tanren's own integrations** (the rest of this doc): the integrations
  **Tanren** uses to operate on the user's behalf — ingest issues (Sentry/Linear),
  notify + interact (Slack as a Forge interaction plane), provision compute + run
  (cloud allocators), deploy (Vercel/Fly), VCS (the GitHub App). Org-granted,
  Tanren-managed via `org_integrations` + the `IntegrationProvisioner` port.

- **Plane B — the built project's app environment** (see "Project app environment"
  below): the environment variables + secrets the **product Tanren is building**
  needs at build / test / deploy / runtime — which may have **zero overlap** with
  Tanren's own integrations. If the app sends email via Resend, it needs
  `RESEND_API_KEY`; Tanren has no Resend integration and does not need one. These
  are the **app's** secrets, not Tanren's.

The same provider can appear in both planes for different consumers and must stay
separate: Tanren's **own** Slack (the Forge interaction plane the operator uses to
drive Tanren) is Plane A; the apex fixture's product **building its own** Slack bot
is Plane B. They are configured and injected independently.

## Project app environment (Plane B — the built product's own secrets)

A per-project **App Environment** store holds the building product's env vars +
secrets, distinct from `org_integrations`:

- **Entry shape:** `{ key (e.g. RESEND_API_KEY), value (secret → secret manager;
non-secret config → projects.config), scopes: [build | test | runtime | dev],
description, source: byo | provisioned }`. Secret values never live in DB config
  or env except test import/bootstrap (same rule as Plane A).
- **BYO is the default path.** The operator adds an app secret with one form field
  ("add `RESEND_API_KEY`"), minimal friction, an explainer + deep link where the
  provider itself needs account setup. Tanren does **not** need to understand
  Resend — it stores + injects the value.
- **Provisioner-backed is the enhancement.** Where Tanren _does_ have an
  `IntegrationProvisioner` for what the app wants (e.g. the app wants Sentry, and
  Tanren has a Sentry provisioner), "enable Sentry **for the app**" can provision
  the app's own Sentry project + inject its DSN as an app env var — same provisioner,
  but the artifact lands in Plane B (the app's environment), not Plane A.
- **Injection by scope — the value reaches the app at the right phase:**
  - **`dev` / DAG execution:** the run workspace (over the runner) gets the
    dev+test app env so the building agent can run + test the app it is writing.
    Materialized like run credentials (over SSH, never logged), but resolved from
    the **project App Environment** store, not Tanren's provider creds.
  - **`test` / gate:** the test-scoped vars reach the gate run — because the gate
    (`.tanren/ci.yml`) runs **over SSH on the runner, not in GitHub Actions**,
    Tanren injects the test-scoped app env into the gate command's environment via
    the SSH prelude (`engine/ssh/appEnvPrelude.ts`, resolved by
    `workflow/attachRuntimeAppEnv.ts`), never logged and never written to an event.
    There are **no** target-repo Actions secrets and no `setActionsSecret` — that
    is impossible under v21's Action-less delivery.
  - **`runtime` / deploy:** the deploy provisioner attaches the runtime-scoped vars
    as the **deployed app's** environment (Vercel/Fly env), so the live product has
    its secrets.

This is shipped (the App Environment store + the scope-resolved SSH injection),
parallel to the Plane-A provisioner work and exercised by `apex` (the apex
product's Slack bot token + any app env are Plane B).

## Boundary model

| Layer            | Stored where                                                              | Examples                                                                                                                             | Rule                                                           |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Org grant        | `organizations.config` points at managed credentials                      | GitHub App install, Sentry org token, Slack app/bot token, Hetzner project token, deploy provider token                              | Human grants this once. It can authorize resource creation.    |
| Project artifact | `projects.config`, `inbox_sources`, notification targets, deploy metadata | Sentry project slug + DSN, Linear team/project filters, Slack channel or webhook, PagerDuty service/routing key, preview URL pattern | Tanren creates or discovers this from the org grant.           |
| Runtime secret   | Secret manager only                                                       | App private key, API tokens, DSNs, webhooks, routing keys                                                                            | Never stored in DB config or env except test import/bootstrap. |

## Integration matrix

| Integration               | Correct org-level grant                                                                         | Project/resource artifact Tanren should manage                               | Current code state                                                                                                               | Required change                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub App                | App id + private key + installation id in org config                                            | Repo access, issue webhook sources, PR branches/statuses                     | Closest to correct: per-org installation token minting exists. Install may be overly broad or manually scoped.                   | Keep as org grant. Add repo access checks and least-privilege install guidance; avoid PAT as primary path.                                                            |
| GitHub Issues intake      | Reuse GitHub App installation                                                                   | `inbox_sources` per project/repo and webhook secret per source               | Mostly correct for intake; webhook receiver requires per-source secret.                                                          | Add provisioning flow that creates project inbox source automatically when a repo is linked.                                                                          |
| Sentry                    | Org/internal integration token with read/write project scopes                                   | Sentry project, client key/DSN, optional service hook, project inbox source  | Current `SentryConfig` requires manual `org + project`; no provisioning client.                                                  | Add Sentry org integration + provisioner: create/list project, create client key, store DSN, create inbox source.                                                     |
| Linear                    | Workspace OAuth/app token or org-level API grant                                                | Team/project mapping, labels/states filters, source config                   | Current connector uses `teamId`/`projectId` if provided but assumes they already exist.                                          | Add discovery/provisioning flow: list teams/projects, bind Tanren project to selected or created Linear project; source config stores IDs.                            |
| Jira                      | Site-level API/OAuth grant                                                                      | Jira project key/issue type/webhook/source config                            | Connector is project-key oriented.                                                                                               | Treat Jira site as org grant; add project discovery/create or explicit bind during project onboarding.                                                                |
| Slack notifications       | Slack app/bot token, plus incoming-webhook capability when used                                 | Channel, incoming webhook, or app channel membership per Tanren project      | Current Tanren notification adapter only sends to a pre-created incoming webhook URL; apex product can use bot token separately. | Add Slack provisioner: create/select channel where API permits, install/authorize app, create/store webhook or use bot `chat.postMessage`.                            |
| Slack project secret      | Slack app/bot token                                                                             | App-specific project secret injected into generated product                  | Manifest models this as a project secret but creation is still manual.                                                           | Let generated projects request a Slack integration capability; Tanren provisions/stores project secret and emits setup code/env.                                      |
| Discord notifications     | Bot token or server-level webhook-management grant if available; otherwise user-created webhook | Channel webhook URL                                                          | Current adapter requires a webhook URL. Discord webhook creation often needs interactive/user permission.                        | Keep manual webhook as acceptable fallback, but model it as project/channel artifact. If bot flow lands, create webhooks/channels via bot permission.                 |
| Teams notifications       | Microsoft app/Graph credential or incoming webhook URL                                          | Channel/webhook URL                                                          | Current adapter requires webhook URL.                                                                                            | Add Graph-based provider if Teams matters; otherwise document manual webhook as fallback artifact, not org config.                                                    |
| Generic webhook           | Endpoint base/receiver capability owned by operator or Tanren                                   | Per-project URL/signing secret subscription                                  | Current channel only POSTs to a destination URL; manifest mentions signing secret but code does not sign.                        | Add outbound signing and a webhook destination provision/test flow.                                                                                                   |
| Email                     | Domain/provider API key, verified sender/domain                                                 | Sender identity, recipient targets, templates                                | Current adapter needs endpoint/API key refs and recipient destination.                                                           | Treat provider key/domain as org grant; provision sender/domain only where API permits; project targets remain config.                                                |
| PagerDuty                 | Account API token or service integration permission                                             | Service/integration routing key                                              | Current adapter needs a routing key.                                                                                             | Add PagerDuty provisioner to create/find service integration and store routing key; keep direct routing key as fallback.                                              |
| Twilio                    | Account SID/auth token with messaging permissions                                               | Messaging service/phone number/sender policy and recipient target            | Current adapter needs SID/token/from number.                                                                                     | Do not require manual per-project setup; add provisioning/discovery for messaging service/from number. A2P compliance remains an operator/account-level prerequisite. |
| ntfy                      | Optional server/topic auth                                                                      | Topic                                                                        | Works as simple topic delivery.                                                                                                  | Keep simple; for private topics, store topic/token as managed artifact.                                                                                               |
| GitHub checks             | Reuse GitHub App                                                                                | PR head status context                                                       | Correctly reuses GitHub auth.                                                                                                    | No new credential; keep tied to VCS integration.                                                                                                                      |
| Hetzner allocator         | Hetzner project API token                                                                       | Per-run SSH key, cloud-init/user data, host identity strategy, server labels | Current allocator requires manual `sshKeys` and a pre-known host key fingerprint.                                                | Add allocator provisioner: create/import ephemeral SSH key, inject runner cloud-init, establish pinned host key via baked image or generated known key.               |
| DigitalOcean allocator    | DO project token                                                                                | SSH key/fingerprint, droplet tags, cloud-init                                | Same manual host-key pattern as Hetzner.                                                                                         | Same provisioner pattern as Hetzner.                                                                                                                                  |
| AWS EC2 allocator         | IAM role/access key scoped to EC2/VPC resources                                                 | Key pair, security group/subnet/AMI/user-data/host key                       | Current allocator requires image/subnet/security group/key/fingerprint values.                                                   | Add AWS environment provisioner or clearly split account bootstrap from per-project provisioning. Prefer short-lived role credentials.                                |
| GCP allocator             | Service account / workload identity                                                             | Project/zone/network/metadata startup script/host key                        | Current allocator is credential + config driven.                                                                                 | Add GCP provisioner/discovery for network/instance template/startup script.                                                                                           |
| Kubernetes allocator      | Cluster/admin or namespace-scoped credential                                                    | Namespace, service account, runner pod/image pull config                     | Current config expects namespace/token.                                                                                          | Add namespace bootstrap provisioner for SaaS/self-hosted clusters.                                                                                                    |
| Deploy target             | Provider org/team token                                                                         | Project/app/site, env vars, preview URL pattern, deployment hook             | Manifest currently treats deploy token as a leaf target. Vercel/Fly support org/app-level workflows.                             | Add deploy provisioners for Vercel/Fly: create app/project, attach env vars, store preview URL pattern and deployment refs.                                           |
| OpenRouter/managed router | Platform/org API key                                                                            | Per-project route/model/budget policy                                        | Mostly correct as org/platform credential.                                                                                       | Keep org-level; project config only selects mode, model policy, budget.                                                                                               |
| Secret stores             | Infra bootstrap credential                                                                      | Secret paths/namespaces                                                      | Correctly bootstrap-level, not per-project.                                                                                      | No user-project provisioning; provide migration/import tooling.                                                                                                       |
| GitHub OAuth / OIDC       | Deployment/client config or per-org IdP app                                                     | Redirect URIs/group mapping                                                  | Currently infra-env.                                                                                                             | For SaaS, Tanren platform owns app; tenant/org mapping is config. For self-hosted, operator creates IdP app once.                                                     |

## Substrate (shipped)

The boundary model above is realized by:

1. The `org_integrations` config surface (separate from `inbox_sources` and
   notification targets): non-secret provider metadata + refs to managed
   credentials, behind the `org_integrations` table + repository.
2. The `IntegrationProvisioner` contract + registry — provider provisioner ports
   separate from the runtime poll/send adapters (Sentry / Slack / Fly / Vercel
   provisioners + the `hetznerAllocator`).
3. Onboarding / greenfield flows request capabilities, not leaf secrets:
   "enable Sentry errors" calls the Sentry provisioner, creates the project /
   key / source, and passes the DSN into the generated project.
   Autonomous greenfield/apex creation also requests `deploy` up front. The
   caller must name `deploy.vercel` or `deploy.flyio`; when the org has not linked
   that provider, creation returns structured `not_linked` evidence instead of
   creating a project with no deploy path.
4. Leaf-resource manual entry (BYO) remains the path for providers that do not
   expose provisioning APIs or require workspace-owner interactive consent.

The per-provider matrix's "Required change" column records the remaining
least-privilege and discovery refinements that are still worthwhile per provider
(e.g. tighter scopes, repo-access checks) — not missing foundations.

## Sentry concrete model

The correct Sentry flow is:

1. Store a Sentry org integration token at the Tanren org level.
2. During project onboarding, Tanren determines the stack/platform from the
   project it is creating or importing.
3. Tanren creates or finds a Sentry project under the configured Sentry team.
4. Tanren creates a client key and stores the DSN as a project secret/artifact.
5. Tanren creates an `inbox_sources` row for that Tanren project using the
   Sentry project slug and the org token ref.

Sentry's API supports the required pieces: create project under a team, create a
project client key/DSN, list organization projects, and register service hooks.
Those operations need project write/admin style scopes for provisioning, not
just `event:read`/`project:read` intake scopes.
