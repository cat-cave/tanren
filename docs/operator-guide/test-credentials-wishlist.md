# Connector-credentials wishlist (for live testing)

Every external surface Tanren can integrate, and the exact credentials/config a
**live** test needs for each. Every entry is grounded in the actual registry /
factory code (paths cited per section), not assumed.

**Status legend**

- **Available** — confirmed present on this machine: the **codex**, **claude**,
  and **opencode** CLIs (their auth bundles can be imported into the secret
  store). Plus anything with a baked dev default in compose.
- **Needed** — an external credential/account we do not yet have and must obtain.

**Two important architectural facts that shape this list**

1. **Cloud-allocator + secret-store creds are read from `process.env`** by their
   factories (`buildAllocator.ts`, `secretStoreFactory.ts`) and the auth env
   loaders. Those map to concrete `TANREN_*` / `VAULT_*` env vars.
2. **Connector + channel + harness creds are NOT env vars.** Inbox connectors,
   notification channels, and agent harnesses resolve their secret from the
   **secret store** by a _credential ref_ (a Vault key like
   `credential/<slug>/<scope>/<owner>/<name>`). For those, the "env var / config
   field" column names the **config field that holds the ref** and the default
   ref, and the live requirement is "the real secret written into the secret
   store under that ref" — not an env var.

---

## A. Minimal set — needed for the golden end-to-end run

The golden run (`docs/operator-guide/operator-driven-run.md`) is:
onboard a real GitHub repo → ingest a candidate → allocate the **dev static
runner** → run a harness (Writer) over SSH → open a draft PR → poll CI. The
default deployment is `static` allocator + `vault` secret store. The minimal
live set is therefore small:

| Surface                            | Credential needed                                                                                               | Env var / config field (code)                                                                                                                                                                                    | How to obtain                                                                                                                                           | Status                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Secret store (Vault)               | Vault address + token                                                                                           | `VAULT_ADDR`, `VAULT_TOKEN` (default `http://localhost:8200` / `dev-root-token`); `TANREN_SECRET_STORE=vault` (default)                                                                                          | Dev Vault ships in the compose stack with the dev root token — already wired                                                                            | **Available** (dev)                                       |
| Static runner (allocator)          | SSH reachability to the dev runner container                                                                    | `TANREN_RUNNER_SSH_HOST` (`runner`), `TANREN_RUNNER_SSH_PORT` (`22`), `TANREN_RUNNER_SSH_USER` (`tanren`), `TANREN_RUNNER_SSH_HOST_FINGERPRINT` (`buildAllocator.ts buildStatic`)                                | Long-lived dev compose runner; defaults work out of the box (`docs/operator-guide/runners.md`)                                                          | **Available** (dev compose)                               |
| Repo connectivity (VCS)            | A GitHub credential for clone / push / draft PR / CI status — **either** a PAT **or** a GitHub App installation | PAT: `github_token` credential kind, secret-store ref (default `credential/github/default`, overridable via `TANREN_GITHUB_APP_TOKEN_REF`) — `githubTokenResolver.ts`. App: see section F                        | PAT: github.com → Settings → Developer settings → fine-grained PAT with repo contents/PR/checks scope. App: section F                                   | **Needed**                                                |
| Agent harness (Writer)             | One harness auth bundle imported into the secret store                                                          | `credentialRef` on the harness adapter; ref must start with `credential/codex/` (codex), `credential/claude/` (claude), or be an opencode/aider key — `codexAuth.ts`, `claudeAuth.ts`, `opencode.ts`, `aider.ts` | Bootstrap the CLI's auth locally, then `tanren credential <codex\|claude\|opencode> import --ref ... --path ...` (`docs/operator-guide/credentials.md`) | **Available** (codex / claude / opencode confirmed local) |
| Identity / login (to drive the UI) | Either dev-login escape hatch **or** a GitHub OAuth app                                                         | Dev: `TANREN_DEV_LOGIN=1` (+ `TANREN_COOKIE_SECURE` must NOT be `1`) — `mainAuth.ts`. OAuth: section E                                                                                                           | Dev-login is on in `compose.dev.yml`; no external cred                                                                                                  | **Available** (dev-login)                                 |

**Minimal golden-run set = 1 external credential: a GitHub repo credential
(PAT or App).** Everything else is satisfied by the dev compose stack
(Vault, static runner, dev-login) plus a locally-available harness
(codex/claude/opencode).

---

## B. Allocators — `engine/allocators/**`

Cloud allocators read resolved secrets from `process.env` in
`buildAllocator.ts`; they are only constructed when the routing config selects
that kind (`TANREN_ALLOCATOR_KIND=router` + `TANREN_ALLOCATOR_ROUTING`, or a
single `TANREN_ALLOCATOR_KIND=<kind>`). Unselected kinds resolve to a throwing
`UnconfiguredAllocator` stub — no creds loaded. All belong to the **optional
surface** group; the golden run uses only `static`.

| Backend          | Credential(s) / config needed                                                                                                                 | Env var / config field (`buildAllocator.ts`)                                                                                                                                                                                                                                    | How to obtain                                                                                                        | Status                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **static**       | SSH host/port/user/fingerprint of the dev runner                                                                                              | `TANREN_RUNNER_SSH_HOST` / `_PORT` / `_USER` / `_HOST_FINGERPRINT` (defaults `runner` / `22` / `tanren`)                                                                                                                                                                        | Dev compose runner                                                                                                   | **Available** (dev)                                                         |
| **sidecar**      | Sidecar base URL + bearer token                                                                                                               | `TANREN_ALLOCATOR_URL` (`http://allocator:3200`), `TANREN_ALLOCATOR_TOKEN` (`dev`)                                                                                                                                                                                              | Run/operate an allocator sidecar; share its bearer token                                                             | **Needed** (real sidecar) — dev default token works against the dev sidecar |
| **manual_ssh**   | JSON array of pre-provisioned SSH hosts (host/port/user/key/fingerprint)                                                                      | `TANREN_MANUAL_SSH_HOSTS` (JSON `ManualSshHost[]`)                                                                                                                                                                                                                              | You already own the box(es); supply SSH host + key + host-key fingerprint                                            | **Needed** (a real host)                                                    |
| **Hetzner**      | Cloud API token + host-key fingerprint (+ optional SSH key ids/region/type)                                                                   | `TANREN_HETZNER_API_TOKEN`, `TANREN_HETZNER_HOST_FINGERPRINT`, optional `TANREN_HETZNER_SSH_KEYS` / `_SERVER_TYPE` / `_IMAGE` / `_LOCATION` / `_SSH_USER`                                                                                                                       | Hetzner Cloud console → project → Security → API Tokens (read/write)                                                 | **Needed**                                                                  |
| **DigitalOcean** | API token + region + host-key fingerprint (+ optional SSH keys/size/image)                                                                    | `TANREN_DO_API_TOKEN`, `TANREN_DO_HOST_FINGERPRINT`, `TANREN_DO_REGION` (`nyc3`), optional `TANREN_DO_SSH_KEYS` / `_SIZE` / `_IMAGE` / `_SSH_USER`                                                                                                                              | DO console → API → Tokens (write scope)                                                                              | **Needed**                                                                  |
| **AWS EC2**      | Access key + secret + region + AMI id + host-key fingerprint (+ optional session token / instance type / key name / subnet / SGs / user-data) | `TANREN_AWS_ACCESS_KEY_ID`, `TANREN_AWS_SECRET_ACCESS_KEY`, `TANREN_AWS_REGION`, `TANREN_AWS_IMAGE_ID`, `TANREN_AWS_HOST_FINGERPRINT`, optional `TANREN_AWS_SESSION_TOKEN` / `_INSTANCE_TYPE` / `_KEY_NAME` / `_SUBNET_ID` / `_SECURITY_GROUP_IDS` / `_USER_DATA` / `_SSH_USER` | AWS IAM user/role with `ec2:RunInstances` etc.; create access key                                                    | **Needed**                                                                  |
| **GCP**          | OAuth2 access token for Compute Engine + project + zone + SSH public key + host-key fingerprint                                               | `TANREN_GCP_ACCESS_TOKEN`, `TANREN_GCP_PROJECT`, `TANREN_GCP_ZONE`, `TANREN_GCP_SSH_PUBLIC_KEY`, `TANREN_GCP_HOST_FINGERPRINT`, optional `TANREN_GCP_MACHINE_TYPE` / `_IMAGE` / `_SSH_USER`                                                                                     | GCP project + service account with Compute Admin; mint a short-lived access token (`gcloud auth print-access-token`) | **Needed**                                                                  |
| **Kubernetes**   | API server URL + ServiceAccount bearer token + namespace + runner image + SSH public key + host-key fingerprint (+ optional CA PEM)           | `TANREN_K8S_API_SERVER`, `TANREN_K8S_TOKEN_REF`, `TANREN_K8S_NAMESPACE`, `TANREN_K8S_RUNNER_IMAGE`, `TANREN_K8S_SSH_PUBLIC_KEY`, `TANREN_K8S_HOST_FINGERPRINT`, optional `TANREN_K8S_CA_PEM` / `TANREN_K8S_SSH_USER`                                                            | A cluster + a ServiceAccount token with pod-create RBAC in the target namespace                                      | **Needed**                                                                  |

---

## C. Inbox source connectors — `engine/forge/inbox/**`

All four are **pull-based**: each resolves an auth token from the **secret
store** by a `tokenRef` in the source's JSONB config (no env var, no webhook
secret in code). The live requirement is "write the real token into the secret
store under the configured ref." All are **optional surfaces** (the golden run
can ingest a manually-created candidate; ingestion source is not required).

| Connector         | Credential needed                                                      | Config field (code)                                                                                                                                                        | How to obtain                                                                                                                | Status                               |
| ----------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **GitHub Issues** | GitHub token (App installation token preferred; static PAT fallback)   | App installation block on the org, or static ref via `resolveGithubToken` (`githubConnector.ts`, `githubTokenResolver.ts`); default static ref `credential/github/default` | Same GitHub PAT/App as section A                                                                                             | **Needed** (same cred as golden run) |
| **Sentry**        | Sentry org/internal-integration token with project provisioning scopes | Org-level integration should provision project/key/source; current `SentryConfig` only polls an already-known project (`sentryConnector.ts`)                               | Sentry → Settings → Developer/Internal Integrations → auth token (`org:read`, `project:write`/`project:admin`, `event:read`) | **Needed; code gap**                 |
| **Linear**        | Linear workspace API/OAuth grant                                       | Org/workspace integration should discover or bind teams/projects; current `LinearConfig` only polls IDs already configured (`linearConnector.ts`)                          | Linear → Settings → API / OAuth app                                                                                          | **Needed; code gap**                 |
| **Jira**          | Jira Cloud account email + API token (HTTP Basic)                      | `baseUrl` (`https://<site>.atlassian.net`), `email`, `tokenRef` in `JiraConfig` (`jiraConnector.ts`)                                                                       | id.atlassian.com → Security → API tokens; pair with account email                                                            | **Needed**                           |

---

## D. Notification channels — `engine/notifications/channels/**` (all 9)

Channels resolve their secret from the **secret store** by a credential ref —
usually the target's `destination` string is itself the ref, or a fixed default
ref. None read a `TANREN_*` cred env var (the one exception: ntfy's base URL).
All are **optional surfaces** — the golden run does not require notifications.

| Channel               | Credential needed                                                                          | Field / ref (code)                                                                                                                          | How to obtain                                                           | Status                                  |
| --------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| **ntfy**              | None for public/self-hosted topic; optional base URL                                       | `TANREN_NTFY_BASE_URL` env (default `http://ntfy:80`); destination = topic URL or bare topic (`ntfy.ts`)                                    | Self-hosted ntfy (in dev compose) or ntfy.sh; no token by default       | **Available** (dev compose)             |
| **Slack**             | Incoming-webhook URL (write-only secret)                                                   | secret-store ref in target `destination` (or verbatim URL) (`slack.ts`)                                                                     | Slack app → Incoming Webhooks → add webhook to a channel                | **Needed**                              |
| **github-checks**     | GitHub token (App installation preferred; static fallback)                                 | resolves via `resolveGithubToken({ secrets, installation })` (`githubChecks.ts`)                                                            | Same GitHub App/PAT as section A                                        | **Needed** (same cred as golden run)    |
| **Teams**             | Incoming-webhook URL                                                                       | secret-store ref in `destination` (or verbatim `*.webhook.office.com` URL) (`teams.ts`)                                                     | Teams channel → Connectors → Incoming Webhook                           | **Needed**                              |
| **Discord**           | Webhook URL                                                                                | secret-store ref in `destination` (or verbatim `discord.com/api/webhooks/...`) (`discord.ts`)                                               | Discord channel → Integrations → Webhooks                               | **Needed**                              |
| **Email**             | Email API endpoint + API key (SMTP relay or HTTP API e.g. SendGrid/Mailgun) + From address | `apiEndpointRef`, `apiKeyRef` (secret-store refs) + `from` on `EmailChannelDeps` (`email.ts`)                                               | SendGrid/Mailgun account → API key + verified sender                    | **Needed**                              |
| **Twilio**            | Account SID + auth token + From number                                                     | secret-store refs `credential/twilio/account-sid`, `credential/twilio/auth-token`, `credential/twilio/from-number` (defaults) (`twilio.ts`) | Twilio console → Account SID + Auth Token + a verified/purchased number | **Needed**                              |
| **PagerDuty**         | Events v2 routing/integration key                                                          | secret-store ref in `destination` (or verbatim 32-char routing key) (`pagerduty.ts`)                                                        | PagerDuty service → Integrations → Events API v2 → Integration Key      | **Needed**                              |
| **Webhook (generic)** | Target webhook URL (write-only)                                                            | secret-store ref in `destination` (or verbatim URL) (`webhook.ts`)                                                                          | Any endpoint you control (e.g. webhook.site for testing)                | **Needed** (trivial — use webhook.site) |

---

## E. Secret stores — `engine/contracts/secretStoreFactory.ts`

Selected by `TANREN_SECRET_STORE` (default `vault`). Each backend reads its own
resolved creds from env. Only the active backend needs creds; **Vault (dev) is
the golden-run default**. The others are **optional surfaces**.

| Backend                 | Credential needed                                                                | Env var (`secretStoreFactory.ts`)                                                                                                                               | How to obtain                                                  | Status              |
| ----------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------- |
| **memory**              | None (ephemeral, test-only)                                                      | `TANREN_SECRET_STORE=memory`                                                                                                                                    | n/a                                                            | **Available**       |
| **Vault**               | Address + token (+ optional KV mount)                                            | `VAULT_ADDR` (`http://localhost:8200`), `VAULT_TOKEN` (`dev-root-token`), optional `VAULT_KV_MOUNT`                                                             | Dev Vault in compose; prod = a real Vault + token              | **Available** (dev) |
| **GCP Secret Manager**  | Project + OAuth2 access token (+ optional API base)                              | `TANREN_GCP_SM_PROJECT`, `TANREN_GCP_SM_ACCESS_TOKEN`, optional `TANREN_GCP_SM_API_BASE`                                                                        | GCP project + SA with Secret Manager access; mint access token | **Needed**          |
| **AWS Secrets Manager** | Access key + secret + region (+ optional session token / name prefix / endpoint) | `TANREN_AWS_SM_ACCESS_KEY_ID`, `TANREN_AWS_SM_SECRET_ACCESS_KEY`, `TANREN_AWS_SM_REGION`, optional `TANREN_AWS_SM_SESSION_TOKEN` / `_NAME_PREFIX` / `_ENDPOINT` | AWS IAM user/role with `secretsmanager:*` on the prefix        | **Needed**          |
| **1Password**           | Connect server URL + Connect token + vault id (+ optional field label)           | `TANREN_OP_CONNECT_URL`, `TANREN_OP_CONNECT_TOKEN`, `TANREN_OP_VAULT_ID`, optional `TANREN_OP_FIELD_LABEL`                                                      | 1Password Connect server + access token + target vault UUID    | **Needed**          |

---

## F. Identity providers — `auth/**`

Registered from env in `mainAuth.ts` / `oidcEnv.ts`. The golden run can use the
**dev-login** escape hatch (`local_dev`), so external IdP creds are an
**optional surface**.

| Provider               | Credential needed                                                     | Env var (code)                                                                                                                                                                                 | How to obtain                                                                         | Status              |
| ---------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------- |
| **github_oauth**       | OAuth App client id + secret                                          | `TANREN_GITHUB_OAUTH_CLIENT_ID`, `TANREN_GITHUB_OAUTH_CLIENT_SECRET` (+ `TANREN_PUBLIC_BASE_URL` for callback) (`mainAuth.ts`)                                                                 | github.com → Settings → Developer settings → OAuth Apps → register app + callback URL | **Needed**          |
| **Generic OIDC**       | Issuer + client id + client secret (+ optional claim/scope overrides) | `TANREN_OIDC_ISSUER`, `TANREN_OIDC_CLIENT_ID`, `TANREN_OIDC_CLIENT_SECRET`, optional `TANREN_OIDC_SCOPES` / `_SUBJECT_CLAIM` / `_LOGIN_CLAIM` / `_NAME_CLAIM` / `_GROUPS_CLAIM` (`oidcEnv.ts`) | Register a confidential client at your OIDC provider                                  | **Needed**          |
| **Authentik (preset)** | Issuer + client id + client secret (preset fills claims/scopes)       | Same `TANREN_OIDC_*` vars + `TANREN_OIDC_PRESET=authentik` (`authentikEnv.ts`, `oidcEnv.ts`)                                                                                                   | Authentik → Applications/Providers → OAuth2/OIDC provider → client id/secret          | **Needed**          |
| **local_dev**          | None — dev escape hatch                                               | `TANREN_DEV_LOGIN=1` (refused if `TANREN_COOKIE_SECURE=1`) (`mainAuth.ts`)                                                                                                                     | Set in `compose.dev.yml`                                                              | **Available** (dev) |

---

## G. VCS / GitHub App — repo connectivity

The preferred repo-connectivity model. Either a **GitHub App installation**
(auto-minting, rotating installation tokens) or a **static PAT** fallback. This
is the **one external credential the golden run actually needs** (listed in
section A); included here in full.

| Mode                      | Credential needed                                        | Env var / config / ref (code)                                                                                                                                                                                                                                                                                                                     | How to obtain                                                                                                                                            | Status     |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **GitHub App**            | App id + private-key PEM, plus a per-org installation id | `github_app` credential kind = `{ appId, privateKeyPem }` stored at a Vault ref (`githubApp.ts`); install flow needs `TANREN_GITHUB_APP_INSTALL_URL` + `TANREN_GITHUB_APP_CREDENTIAL_REF` (`githubAppInstall.ts`); installation block `{ installationId, appId, credentialRef }` on the org (`githubTokenResolver.ts`, `githubAppTokenMinter.ts`) | github.com → Settings → Developer settings → GitHub Apps → create app (contents/PR/checks perms) → download private key → install on the target org/repo | **Needed** |
| **Static PAT** (fallback) | A GitHub personal access token                           | `github_token` credential kind at secret-store ref; default `credential/github/default`, overridable via `TANREN_GITHUB_APP_TOKEN_REF` (`githubTokenResolver.ts`)                                                                                                                                                                                 | github.com fine-grained PAT with repo contents/PR/checks scope                                                                                           | **Needed** |

---

## H. Agent harnesses / providers — `engine/providers/**`

Harness creds are **imported auth bundles / API keys** stored in the secret
store and referenced by a per-run `credentialRef` — never env vars. **One**
harness is enough for the golden run, and codex/claude/opencode are locally
available. The managed-provider (platform OpenRouter) path is an optional
hosting concern.

| Harness / provider                               | Credential needed                                                                      | Config field / ref (code)                                                                                                                                                                        | How to obtain                                                          | Status                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------- |
| **codex**                                        | Codex CLI `auth.json` bundle                                                           | `credentialRef` starting `credential/codex/` (`codex.ts`, `codexAuth.ts`)                                                                                                                        | Bootstrap codex login locally, `tanren credential codex import`        | **Available**                     |
| **claude**                                       | Claude CLI auth bundle                                                                 | `credentialRef` starting `credential/claude/` (`claude.ts`, `claudeAuth.ts`)                                                                                                                     | Bootstrap claude auth locally, `tanren credential claude import`       | **Available**                     |
| **opencode**                                     | opencode CLI auth bundle                                                               | `credentialRef` (`opencode_cli_auth` kind) (`opencode.ts`)                                                                                                                                       | Bootstrap opencode auth locally, `tanren credential opencode import`   | **Available**                     |
| **aider**                                        | Model-provider API key (OpenAI/Anthropic/Gemini per model, or OpenRouter when managed) | `credentialRef` → key resolved by `resolveAiderApiKey`; env-var on the runner picked per model: `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` (`aider.ts`)                           | OpenAI / Anthropic / Google AI Studio / OpenRouter dashboard → API key | **Needed** (no aider key locally) |
| **Managed provider** (platform OpenRouter shell) | Platform OpenRouter API key written to a platform ref                                  | `providerMode: "managed"`; `ManagedProviderConfig.credentialRef` (default `credential/openrouter/platform/default`) + `endpoint` (default `https://openrouter.ai/api/v1`) (`managedProvider.ts`) | openrouter.ai → Keys → create API key (a hosting-layer concern)        | **Needed**                        |

---

## Summary — minimal vs full set

- **Minimal set (golden end-to-end run): exactly ONE external credential to
  obtain — a GitHub repo credential (a PAT, or a GitHub App installation).**
  Everything else is already satisfied: dev Vault, the dev static runner, and
  dev-login all ship in the compose stack, and a Writer harness
  (codex / claude / opencode) is locally available to import.

- **Full set (every optional surface):** add, per surface you want to live-test —
  - Allocators: Hetzner / DigitalOcean / AWS-EC2 / GCP / Kubernetes API creds (+
    SSH key + host-key fingerprint each); a real sidecar token; a manual-SSH host.
  - Inbox: Sentry, Linear, Jira tokens (GitHub Issues reuses the golden GitHub cred).
  - Notifications: Slack / Teams / Discord / PagerDuty / generic webhook URLs;
    Email API key + sender; Twilio SID/token/number (github-checks reuses the
    golden GitHub cred; ntfy needs none).
  - Secret stores: GCP SM / AWS SM / 1Password creds (only if not using Vault).
  - Identity: GitHub OAuth app, or OIDC/Authentik issuer + client id/secret
    (only if not using dev-login).
  - Harnesses: an aider model-provider key, and (hosting only) a platform
    OpenRouter key for managed mode.
