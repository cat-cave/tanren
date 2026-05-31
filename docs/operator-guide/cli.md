# Tanren CLI Reference

The `tanren` CLI is a thin wrapper over the orchestrator's HTTP API. Auth is a
bearer token stored at `~/.config/tanren/auth.json` (P2A-0003). Every state-
changing CLI command issues an authenticated request through that token, so
log in once and then run commands without re-prompting.

```sh
tanren auth login                  # browser handshake, persists the token
tanren auth status                 # prints token metadata, never the token
tanren auth logout                 # clears the token file
```

`--json` is the default output format. Every command emits a 2-space-indented
JSON document on stdout, suitable for piping into `jq`.

## Health and diagnostics

```sh
tanren doctor                       # GET /doctor, returns the DoctorReport JSON
tanren status <run_id>              # GET /runs/<run_id>
tanren dashboard                    # prints the dashboard URL
```

`tanren doctor` mirrors the `GET /doctor` endpoint exactly; both surface the
same `DoctorReport` shape (`ok`, `checks[].name`, `checks[].status`,
`checks[].detail`, `checks[].latencyMs`).

## Orgs

```sh
tanren orgs list
tanren orgs get <orgId>
tanren orgs config-set --org-id <orgId> --config-json '{"version":1,...}'
```

`config-set` validates the body against `OrgConfigV1` (P2A-0006) before
persisting; unknown fields are rejected with `400`.

## Projects

```sh
tanren projects list  --org-id <orgId>
tanren projects create --org-id <orgId> --name <name> --repo-url <url>
                       [--default-branch <branch>] [--runner-image <ref>] [--allocator <name>]
tanren projects get   --org-id <orgId> --project-id <projectId>
tanren projects link  --org-id <orgId> --project-id <projectId> --repo-url <url>
                       [--github-credential-ref <ref>]
```

`projects link` is the brownfield contract: the orchestrator verifies the
configured GitHub App can `GET /repos/:owner/:repo`, reads
`.github/workflows/`, `.mergify.yml`, and `CODEOWNERS` for display, and
persists the linkage. **No files are ever written to the target repository.**

## Specs

```sh
tanren specs list   --org-id <orgId> --project-id <projectId>
tanren specs create --org-id <orgId> --project-id <projectId> \
                    --title <t> --description <d> --acceptance <c> [--acceptance <c2>] \
                    [--depends-on <specId>]
tanren specs get    --org-id <orgId> --project-id <projectId> --spec-id <specId>
tanren specs run    --org-id <orgId> --project-id <projectId> --spec-id <specId> \
                    [--branch <branch>] [--trigger cli|dashboard|api|webhook]
```

`specs run` enforces the spec dependency rule from P2A-0018; a spec with
`dependsOn` cannot run until each dependency is `done`. The HTTP path returns
`spec_dependencies_blocked` (409) and the CLI surfaces that as a non-zero exit
status.

## Personas, behaviors, milestones

```sh
tanren personas list   --org-id <orgId> [--project-id <projectId>]
tanren personas create --org-id <orgId> [--project-id <projectId>] --name <n> [--description <d>]
tanren personas get    --org-id <orgId> --persona-id <id>

tanren behaviors list   --org-id <orgId> --project-id <projectId> --persona-id <id>
tanren behaviors create --org-id <orgId> --project-id <projectId> --persona-id <id> \
                        --title <t> [--given <g>] [--when <w>] [--then <t>] [--description <d>]
tanren behaviors get    --org-id <orgId> --project-id <projectId> --behavior-id <id>

tanren milestones list   --org-id <orgId> --project-id <projectId>
tanren milestones create --org-id <orgId> --project-id <projectId> --label <l> --name <n> \
                         --order-index <n> [--eta <iso>] [--status planned|in_flight|done|abandoned]
tanren milestones get    --org-id <orgId> --project-id <projectId> --milestone-id <id>
```

Personas without `--project-id` are org-scoped and visible to every project in
the org; personas under `--project-id` are project-scoped (P2A-0018 visibility
rule).

## Credentials

Credential **values** never leave the orchestrator; the CLI only emits the
credential reference and metadata.

```sh
tanren credentials list   [--org-id <orgId>]            # personal scope when omitted
tanren credentials create [--org-id <orgId>] --ref <ref> --value <value> [--kind <kind>]
tanren credentials get    --org-id <orgId> --ref <ref>
tanren credentials delete --org-id <orgId> --ref <ref>
```

Supported `--kind` values: `opaque` (default), `github_token`,
`codex_chatgpt_auth`. For `github_token`/`codex_chatgpt_auth`, `--value` is
the raw token / auth JSON. For `opaque`, `--value` is whatever string the
operator wants stored.

The Phase 1 import commands continue to work:

```sh
tanren credential codex import  --ref <ref> --auth-json-file <path>
tanren credential github import --ref <ref> --token-file <path>
```

These are equivalent to `tanren credentials create --kind <…>` and also
register the ref in the credential registry so it appears in `credentials list`.
