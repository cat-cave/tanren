# Managed Credentials

Tanren credentials are imported explicitly and stored in Vault. The orchestrator does not discover host `~/.codex`,
`~/.config`, or environment-provider credentials, and runner containers do not receive host credential bind mounts.

## Codex ChatGPT Auth

Bootstrap Codex auth intentionally, then import the resulting managed `auth.json` bundle by path:

```sh
corepack pnpm --filter @tanren/cli tanren credential codex import \
  --ref credential/codex/dev \
  --auth-json-file /path/to/auth.json
```

The CLI sends the file contents to the orchestrator, which validates that the payload is JSON and stores it in Vault
under the explicit ref. Responses include only the credential kind, ref, and a redaction marker.

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
  corepack pnpm --filter @tanren/cli tanren credential codex import \
  --ref credential/codex/dev \
  --auth-json-file /path/to/auth.json
```

Do not use a host default path. The auth file path must be provided intentionally for each import.

## GitHub Token

The Phase 1 live workflow also needs a managed GitHub credential that can push a branch and open a draft PR in the target fixture repository. The current live harness accepts a token file through `TANREN_GITHUB_TOKEN_FILE` and stores the value in Vault for the run.

Treat the token file as a bootstrap input, not runtime state. Create it with restrictive permissions, pass the path explicitly, and remove it after the live run. Workflow events should record only the credential ref and redacted metadata, never the token value.
