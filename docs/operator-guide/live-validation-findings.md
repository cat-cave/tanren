# Live-validation findings (the live demo is complete)

The P3-0009 live demo is **DONE**. A real operator-driven validation completed
on `main` across **three tiers** — easy, medium, and hard (the hard one a
**private** repo) — each reaching a **merged PR** with real Codex and real
credentials. This records **what each tier proved, the gaps live validation
found-and-fixed, and the config gotchas** — so a fresh agent can reproduce the
validated state without rediscovering them.

The single live forward tracker is `docs/roadmap/tempering.md`; the detailed
four-dimension plan is `docs/roadmap/forward-roadmap.md`.

## What the three tiers proved (each reached a merged PR)

Each tier was driven by a real operator flow — sign in → create an org → import
real provider credentials → link a repo → submit a spec → trigger a run → watch
it merge — entirely through real adapters (no fakes in the runtime path).

| Tier   | Repo        | Integration policy                                                                  | What it proved                                                                                                                                                                                                                                          |
| ------ | ----------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Easy   | public      | `governancePosture: open` · `mergeIntegration: direct_merge` · `reviewPolicy: auto` | the full loop `plan → real-agent write → check → audit → native gate → merge` reaches a merged PR.                                                                                                                                                      |
| Medium | public      | same + a two-tier `.tanren/ci.yml` (typecheck + tests)                              | the write stage implements functions so a committed test suite passes; the native `pre_merge` gate (run over SSH, **not** Actions) admits the merge.                                                                                                    |
| Hard   | **private** | same + `reviewPolicy: simulated`                                                    | private-repo clone auth works; real logic + rigorous CI; the **orchestrator-managed simulated reviewer** posts a real GitHub `COMMENT` review and drives the verdict internally (self-PR-safe) — the human-review path runs end-to-end without a human. |

All three of the project's cost models, the event log, and full run/task
provenance are persisted and inspectable.

## Gaps live validation found-and-fixed (all merged + regression-tested on `main`)

The earlier RLS-completeness bugs (caught by the first operator-driven run, fixed
before the loop closed):

| Bug the live run caught                                                            | Fix / smoke target                  |
| ---------------------------------------------------------------------------------- | ----------------------------------- |
| Org / identity creation 500'd under RLS (bootstrap not in the system bypass scope) | `just smoke-rls-org-bootstrap`      |
| Operator / control-plane HTTP routes not org-scoped                                | `just smoke-rls-operator-flow`      |
| Resource-keyed + path HTTP route shapes not establishing org scope                 | `just smoke-rls-http-route-scoping` |
| The run-lifecycle allocator write (and full lifecycle) not scoped                  | `just smoke-rls-run-lifecycle`      |
| The standalone allocator service not org-threaded                                  | `just smoke-rls-allocator`          |

The harness-integration frontier (formerly `All configured authentication
methods failed`) was the resume point — it is now **resolved**, and closing it
surfaced and fixed a chain of real gaps:

- **Durable credential / runner-identity registry.** The in-memory registry lost
  credentials on restart, which broke runner-identity resolution in the live
  path. The registry is now **Vault-backed and durable** (survives an
  orchestrator restart); this needed a `SecretStore.list(prefix)` contract method
  (added across all secret-store backends).
- **Bootstrap robustness.** The built worker's real (non-fake) path was hardened:
  bootstrap skips when there is no manifest and prefers npm; the runner image
  carries **pnpm**; the answerer JSON schemas are copied into `dist`; `.claude/`
  is excluded from the Docker build context so bootstrap artifacts don't leak.
- **Cumulative-diff convergence.** The planner emits actionable subtasks; the
  checker defers test/build/lint-outcome criteria to the deterministic gate; the
  writer's diff is judged against the **post-bootstrap run base**, so replanned
  already-done work and install artifacts aren't false-rejected.
- **P3c cost-reconcile + lifecycle routing.** The run/spec/task lifecycle writes
  (and cost reconcile) route through the control-plane `/internal/*` endpoints;
  the data-plane grants on those tables are dropped.
- **Review / merge credential resolution.** The review and merge stages resolve
  the GitHub credential correctly through the org-scoped registry.
- **`reviewPolicy` + `markReadyForReview` GraphQL.** The `reviewPolicy` enum is
  `["human", "auto", "simulated"]`; un-drafting a PR uses the GraphQL
  `markPullRequestReadyForReview` mutation.
- **Private-repo clone auth.** The workspace clone authenticates the org's GitHub
  token over HTTPS (token via stdin / `GIT_ASKPASS`, never on the command line),
  so **private target repos work**.
- **Simulated-reviewer self-PR safety.** The orchestrator-managed simulated
  reviewer posts a real GitHub **`COMMENT`** review (not `APPROVE`/`REQUEST_CHANGES`,
  which GitHub forbids on your own PR) and drives the verdict internally.

These prove RLS + the de-privileged plane split + the real harness across the
**data layer, the run-execution path, the HTTP operator + resource routes, the
full run lifecycle, and the standalone allocator** — not just a synthetic
fixture. The plane-split de-privilege has its own negative proofs:
`just smoke-plane-split-p3b` and `just smoke-plane-split-p3c` (the data plane is
rejected with `42501` when it tries to write `events`/`cost_records`, then
`runs`/`specs`/`tasks`).

## Config gotchas (still useful when you reproduce a run)

- **`tanren orgs config-set` REPLACES the whole config.** The PATCH endpoint
  validates the supplied body against `OrgConfigV1` and persists _that whole
  object_ (`migrateOrgConfig(parsed.data.config)` in
  `services/orchestrator/src/routes/orgs/index.ts`) — it is **not** a deep merge.
  Always send the _complete_ config you want, or you will silently drop fields
  (e.g. the audit gate). Unknown fields are rejected with `400`.

- **Credential ref namespace.** Org-scoped credentials live under
  `credential/<slug>/org/<orgId>/<name>` (personal under
  `credential/<slug>/me/<userId>/<name>`). The orchestrator **derives** the ref
  server-side from the authenticated `{kind, scope, ownerId}` plus a caller name;
  a caller-supplied ref naming a _different_ tenant is rejected with `400`.
  Import through the **org-scoped** surface (`POST /orgs/:orgId/credentials`, or
  `tanren credentials create --org-id …`). The legacy top-level import routes have
  been **deleted** — the org-scoped (and `me`-scoped) surface is the only import
  path, and the registry is durable, so an imported credential survives a restart
  and appears in the credential LIST.

- **Fresh / reset dev DB.** The schema makes `org_id` NOT NULL on the core
  tables; a dev volume created before that constraint existed cannot be
  backfilled in place. A live run needs a fresh or reset dev DB (`just down-dev`
  then `just up-dev`). Volume wipes are expected — Tanren has no legacy-data
  compatibility surface.

- **Prod role passwords.** The baseline schema creates the
  `tanren_app`/`tanren_system`/`tanren_dataplane` roles with DEV/CI default
  passwords. Production rotates each out-of-band and supplies it via the runtime
  `DATABASE_URL` / `TANREN_SYSTEM_DATABASE_URL` / `TANREN_DATAPLANE_DB_PASSWORD`.

## How to reproduce the validated state

1. Bring up a fresh dev DB and the stack (`just up-dev`; see
   `docs/operator-guide/operator-driven-run.md`). Confirm
   `http://localhost:3100/healthz` and the dashboard are healthy.
2. Onboard via the dashboard or CLI (`cli.md`, `credentials.md`): create an org,
   import real Codex/GitHub creds through the **org-scoped** surface, link a
   fixture repo, and set the project config for the tier you're testing
   (`reviewPolicy: auto` for easy/medium; add a `.tanren/ci.yml` to the target
   repo for the native gate tiers; `reviewPolicy: simulated` for hard).
3. Submit a spec and `tanren specs run`. Watch it reach a merged PR.
4. `just smoke` proves the boundaries (connectivity, SSH, the plane-split
   `42501` de-privilege proofs through P3c, the RLS isolation proofs including
   `smoke-rls-allocator`) with no real credentials.

The three fixtures used for the live proof are
`cat-cave/tanren-fixture-{easy,medium,hard}`.
