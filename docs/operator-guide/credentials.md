# Managed Credentials

Tanren credentials are imported explicitly and stored in a secret store. The orchestrator does not discover host `~/.codex`,
`~/.config`, or environment-provider credentials, and runner containers do not receive host credential bind mounts.

## Credential kinds

The credential registry supports these kinds (`engine/credentials/`):

- `codex_chatgpt_auth` — a Codex CLI `auth.json` bundle (Writer/Answerer).
- `claude_cli_auth` — a Claude CLI auth bundle (Writer/Answerer; P3-0012).
- `opencode_cli_auth` — an opencode CLI auth bundle (Writer; P3-0012).
- `github_token` — a GitHub PAT / install token for clone, push, opening the draft PR, publishing the `tanren/gate` verdict, and accepting the merge.
- `github_app` — a GitHub **App installation** (App id + private-key PEM); per-org installation tokens auto-mint and rotate (P3-0003). This is the preferred repo-connectivity model; `github_token` is the path when no App is installed (the dev / no-App-installed path).
- `opaque` — an arbitrary write-only secret blob.

## Secret-store backends + tenant namespacing

The secret store is **pluggable** (`buildSecretStore`): **Vault** (default), **GCP Secret Manager**, **AWS Secrets Manager**, or **1Password**, selected by env. See [`deploy.md`](deploy.md).

Vault refs are **tenant-namespaced**: the import route derives the ref server-side from the authenticated actor as `credential/<slug>/<scope>/<ownerId>/<name>` (`<scope>` is `org` or `me`), so an org admin cannot write to another tenant's key. The read side enforces the same scope/owner on any caller-supplied full ref. There is no bare-ref (`credential/<slug>/<name>`) path and no unscoped top-level import endpoint — the org-scoped and `/credentials/me` routes are the only import surface.

## Codex ChatGPT Auth

Bootstrap Codex auth intentionally, then import the resulting managed `auth.json` bundle through the **org-scoped** credentials surface:

```sh
corepack pnpm --filter @tanren/cli tanren credentials create \
  --org-id <orgId> --kind codex_chatgpt_auth \
  --ref codex-default --value "$(cat /path/to/auth.json)"
```

> The legacy top-level `tanren credential codex import` / `tanren credential github import` commands were **removed** (they POSTed to deleted routes and now fail). `tanren credentials create` is the only import path. The orchestrator derives the tenant-namespaced ref server-side (`credential/<kind>/org/<orgId>/<name>`) and stores it in the secret store. Responses include only the credential kind, ref, and a redaction marker.

Runner sessions materialize the stored bundle into a fresh per-run `CODEX_HOME` over SSH before `codex exec`.
The returned materialization result contains only `CODEX_HOME` and the credential ref; secret values are not emitted
as workflow events. Codex may refresh the cached login during a run; the Writer adapter reads the refreshed
per-run `auth.json` back over SSH and stores it to the same managed credential ref when possible.

Do not run `codex login --device-auth` on every container launch. Device auth is a normal OAuth device-code
bootstrap flow, not a per-run provisioning step. Access-token auth via `codex login --with-access-token` is a
separate future enterprise/programmatic mode, not the base Tanren path.

## Live Dev Check

When the compose stack is running with dev Vault, import a disposable auth fixture and verify the response is redacted:

```sh
TANREN_ORCHESTRATOR_URL=http://127.0.0.1:3100 \
  corepack pnpm --filter @tanren/cli tanren credentials create \
  --org-id <orgId> --kind codex_chatgpt_auth \
  --ref codex-default --value "$(cat /path/to/auth.json)"
```

Do not use a host default path. The auth file path must be provided intentionally for each import.

## GitHub connectivity

A run needs GitHub access to push a branch, open the draft PR, publish the native `tanren/gate` verdict as a check, and accept the merge. (There is no Actions check to read — Tanren runs the gate itself over SSH; see [`ci-config.md`](ci-config.md).) The **preferred** path is a per-org **GitHub App installation** (`github_app` kind): install the App on the org from the dashboard onboarding step, and the orchestrator mints + auto-rotates short-lived installation tokens — no PAT to manage. See [`github-app.md`](github-app.md).

A managed **`github_token`** (PAT or install token) is the path for a dev or self-hosted setup with no App installed: the token resolver (`engine/credentials/githubTokenResolver.ts`) prefers an org App installation token and falls through to the static `github_token` ref when no App is present. When importing a token, treat the token file as a bootstrap input, not runtime state: create it with restrictive permissions, pass the path explicitly, and remove it after import. Workflow events record only the credential ref and redacted metadata, never the token value.
