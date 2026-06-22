# Validation credentials — the real-connection matrix

This is the operator how-to for proving Tanren's connectors **function in
practice**: which creds to provision, where each one lives, and which live check
exercises it. It covers two uses:

1. **Initial individual real validation** — a human wires up one connector and
   runs its targeted live check once.
2. **Recurring real-credential validation** — the same connectors run on a
   credentialed runner on a cadence so a regression that breaks a real connector
   is caught.

## The one principle that shapes the format

**Managed credentials are the default home; env is the narrow exception.**

Almost every credential here is _user configuration_ — it belongs in the secret
manager, set through the dashboard / `tanren credentials create` / the org-config
API, and read by the orchestrator at run time. It must **never** be a production
env var. The only things that legitimately live in env are:

- **Infra bootstrap** that must exist _before_ the secret manager does — the DB
  URL, the secret-store selection, and the secret store's _own_ connection
  credential (you can't store the vault token inside the vault). → `.env`.
- **Test injection** — gating flags and pointers to raw material the test harness
  imports into a fresh stack. → `.env`, `TANREN_E2E_*`.

So the artifacts are split to make that boundary impossible to blur:

| Artifact                                | Holds                                                       | Used by                                                              |
| --------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| **`.env.validation.example`**           | Infra bootstrap + test gating/pointers only (small, finite) | the process at boot; the `just live-*` / `just e2e` harness          |
| **`connections.manifest.example.yaml`** | Every managed credential/connector, declaratively           | real setup (via the product UI) **and** the e2e harness, identically |

### One declaration, two uses

Each manifest entry's `secret.value_source` is what makes a single schema serve
both real-world setup and testing:

- `secret_manager_ref` → **production**: it's already stored; nothing to import.
  This is what a real operator's manifest looks like (they configured it in the
  UI; the manifest just references the stored ref).
- `inline` | `file` | `env` → **testing**: the `just e2e` harness reads the
  manifest, imports each entry into the fresh stack's secret manager, then runs
  the suite. A real operator never fills these in.

That is the seam that guarantees "we test what we ship": the e2e suite configures
connectors through the **same managed-credential path** a user does — never a
back-door env read, never a mock (the §8b no-mock arch check forbids it).

> Several cloud-allocator and IdP creds read from **env today**
> (`TANREN_HETZNER_API_TOKEN`, `TANREN_GITHUB_OAUTH_CLIENT_SECRET`, …). Per this
> principle their **target home is managed per-org config**; the env form is the
> bootstrap/test path until that migration lands. They're marked
> `home: managed-target` / `home: infra-env` in the manifest and tracked for the
> managed-hosting workstream.

## Cadence model (purpose #2)

**Per-PR is never real-credential.** Public PR CI has no secrets. The per-PR fast
path stays fixture + the §8a stub-ban arch lint (`no-production-stubs`) + the §8b
no-mock arch check — both are built and enforced. Real connectors run only on a
credentialed runner, on one of:

| Cadence                     | What runs                                                                                                                                                                                  | Why                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **nightly**                 | Core, cheap, sub-covered: the run loop (Codex), GitHub App + token, Slack/ntfy/webhook delivery, Hetzner provision→run→teardown, the walker driving a multi-spec DAG, github-issues intake | Daily proof the _core_ connectors work end-to-end; near-zero $ (Codex sub + cents of Hetzner) |
| **weekly**                  | Expensive/slow/broad: full **apex**, managed-metered `$` path, alt providers (Claude/opencode), alt secret store (1Password), Discord/email, Sentry/Linear intake, deploy                  | Real but not worth daily cost/time                                                            |
| **on-demand / pre-release** | High-setup or `$$`: GCP/AWS/k8s allocators, Twilio SMS, PagerDuty, Teams, OIDC/Authentik, the remaining secret-store backends                                                              | Provisioned only when touched or before a release                                             |

Each real check asserts on **real persisted artifacts** (a merged PR on GitHub, a
deployed URL, `cost_records` with real basis, a delivered Slack message), never a
mocked return — that's the §8b contract.

## Priority + the wishlist (purpose #1)

`P0` = the apex proof needs it · `P1` = proves a seam only conformance-tested
today · `P2` = breadth. **Already configured:** Codex/Claude/opencode auth, a
GitHub token, the local SSH runner.

### Recommended order to provision

1. **Tier 1 — makes `apex` runnable as designed (P0):**
   - **GitHub App** on a throwaway org/repo — App id + installation id + private-key PEM. Unlocks the preferred connectivity path _and_ real issue webhooks for intake.
   - **Slack org grant** — bot/app token with permission for Tanren to bind or create project channels/webhooks; a pre-created webhook URL is only a validation fallback.
   - **Deploy provider grant** — a Fly.io / Render / Railway / Vercel org/team token (or a Hetzner VM allocator grant), so Tanren can create the apex web UI target instead of requiring a manually-created project.

2. **Tier 2 — proves the seams only conformance-tested today (P1):**
   - **Hetzner** API token — the real allocator-family proof (provision → SSH → run → teardown), cents per run.
   - **Managed-router key** (OpenRouter or a raw OpenAI/Anthropic key) — the managed/metered billing path + the transparent cost+margin record.
   - **One alt secret store** — a 1Password Connect token (url + token + vault id), or a cloud SM credential.

3. **Tier 3 — breadth (P2):** Sentry/Linear org grants (multi-source intake plus project/source provisioning), Discord/SendGrid/Teams/Twilio/PagerDuty (more channels), DigitalOcean/GCP/AWS/k8s (more allocators), GitHub OAuth / OIDC (real sign-in).

Do not treat project-specific upstream resources as operator prerequisites. A
Sentry project, Slack channel/webhook, PagerDuty routing key, deploy app, cloud
SSH key, or preview URL is a Tanren-created artifact when the upstream API
supports it. See [`integration-provisioning.md`](integration-provisioning.md)
for the org-grant vs project-artifact matrix and the code backlog.

All of it fits well under the **$50** ceiling, and the bulk runs on the Codex
subscription. The full per-connector breakdown — kind, scope, ref, config,
secret source, priority, cadence, and exactly what each proves — is the
`connections.manifest.example.yaml` next to this doc.

## How to use it

### Canonical secrets layout

Three operator-local files hold the bootstrap + per-org tier-1 inventory:

| File                              | Holds                                                                  |
| --------------------------------- | ---------------------------------------------------------------------- |
| `.env`                            | Infra bootstrap (DATABASE_URL, VAULT_TOKEN, TANREN_SECRET_STORE, …)    |
| `.env.validation.local`           | Tier-1 live secrets (Hetzner token, OAuth secrets, managed-router key) |
| `connections.manifest.local.yaml` | Apex credential manifest (refs only)                                   |

All three are gitignored. They live canonically in
`${TANREN_SECRETS_DIR:-~/.config/tanren/secrets}/` (0700 dir, 0600 files); every
worktree symlinks them in via `just secrets-link`, which `just up-dev` calls
automatically. **One-time setup** (if your secrets currently sit inline in your
main checkout): `just secrets-migrate` moves them to the canonical location and
symlinks them back, keeping the main checkout working while letting fresh
worktrees see the same set. `just doctor` verifies the layout is intact and
`.env` has the required keys; run it before `just up-dev` from a fresh worktree.

**Secrets mode is explicit, never implicit.** `secrets-link` reads
`TANREN_SECRETS_MODE` (default: `canonical`):

| Mode | Behavior | Used by |
| --- | --- | --- |
| `canonical` (default) | Requires the canonical `.env` at `$TANREN_SECRETS_DIR`. Fails loud if absent. | Real apex / validation runs |
| `dev-defaults` | Links `.env -> .env.example` (compose-friendly defaults, no real creds). | CI / smoke (declared in `.github/workflows/ci.yml`) |

The default is the strict path so a fresh apex run fails closed rather than
silently using dev defaults. CI declares `TANREN_SECRETS_MODE=dev-defaults`
explicitly. **Never set `dev-defaults` for an apex run** — credential
resolution will fail the moment a real GitHub App or Vercel token is needed.

**Real-world setup (an operator):** configure each connector in the dashboard;
your live manifest entries are all `value_source: secret_manager_ref`. Nothing in
env except the infra bootstrap in `.env`.

**Initial validation (one connector):** put the raw material where the manifest's
`file`/`env` points, set the matching `TANREN_*_LIVE` flag, run that connector's
recipe (`just live-codex-*`, `just live-github-draft-pr`, …) or the targeted
`just e2e` case.

**CI automation:** store the `TANREN_E2E_*` material as CI secrets on a
credentialed runner; the nightly/weekly job points `TANREN_CONNECTIONS_MANIFEST`
at the filled-in manifest; the e2e harness imports the **tenant-scoped**
connectors through the operator credential API and runs the cadence's suite; run
IDs + PR URLs + the deployed URL are the release evidence.

### Platform-scoped vs tenant-scoped refs (the deploy-config split)

The manifest mixes two planes, and they are seeded by **different** mechanisms —
do not conflate them:

- **Tenant-scoped connectors** (`home: managed`, an org's GitHub App / deploy /
  Slack / Sentry / … credential) are imported through the **operator credential
  API** (`POST /orgs/:orgId/credentials`), which derives a tenant-namespaced ref
  `credential/<kind>/org/<orgId>/<name>`. This is the only userland import path.
- **Platform-scoped refs** (`platform/`-prefixed) are HOSTING config the operator
  API cannot — by design — write: it always anchors a ref to the authenticated
  tenant. Today the sole platform ref is the managed-LLM router key at
  `credential/openrouter/platform/default` (the manifest's `managed-router`
  connector, read from `TANREN_E2E_MANAGED_ROUTER_KEY`). Under
  `providerMode: managed` every tenant routes through it, and a fresh stack
  (`just down-dev -v` wipes the dev Vault) leaves it unseeded — managed mode then
  hard-fails at credential resolution (correctly; no silent fallback).

Seed the platform refs with the sanctioned hosting seeder:

```sh
just seed-platform-creds
```

It reads `TANREN_E2E_MANAGED_ROUTER_KEY` (sourced from `.env.validation.local`
when present), writes the platform ref into the configured secret store
(`scripts/dev/seed-platform-creds.ts`), is **idempotent**, and **fails loud** if
the key env var is absent (never a silent skip). It is also folded into
`just up-dev`, so a normal dev bring-up seeds it automatically when the key is
present. This is the deploy-layer's job — kept strictly separate from the
tenant credential routes; if a future platform-scoped ref is needed on a fresh
stack, add it to `PLATFORM_REFS` in that seeder (tenant creds stay on the
operator API).
