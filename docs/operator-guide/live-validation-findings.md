# Live-validation findings (where the live demo stands)

A real operator-driven validation run was executed on `main` to live-prove the
multi-tenant + plane-split work end-to-end. This records **exactly what it
validated, where it stopped, and the config gotchas** — so a fresh agent can
resume the P3-0009 live demo without rediscovering them.

> Source: these findings come from the operator's live run report. The RLS-
> completeness fixes they triggered are merged + regression-tested on `main`
> (see the smoke targets below); the harness-frontier items are observed live
> and remain **unbuilt** — they are the resume point, not a claim of completion.

## What the live run validated (merged + regression-tested)

The run drove the real path:

```
signup → CRUD (orgs/projects/specs) → run trigger → mTLS control-plane claim
       → credential resolution → runner allocation
```

…and **caught a class of RLS-completeness bugs the hello-fixture smoke missed**.
Each was fixed and pinned with a regression smoke + integration test:

| Bug the live run caught                                                            | Fix / smoke target                  |
| ---------------------------------------------------------------------------------- | ----------------------------------- |
| Org / identity creation 500'd under RLS (bootstrap not in the system bypass scope) | `just smoke-rls-org-bootstrap`      |
| Operator / control-plane HTTP routes not org-scoped                                | `just smoke-rls-operator-flow`      |
| Resource-keyed + path HTTP route shapes not establishing org scope                 | `just smoke-rls-http-route-scoping` |
| The run-lifecycle allocator write (and full lifecycle) not scoped                  | `just smoke-rls-run-lifecycle`      |

These prove RLS is enforced across the **data layer, the run-execution path, the
HTTP operator + resource routes, and the full run lifecycle** — not just the
synthetic hello fixture. The plane-split de-privilege has its own negative
proof: `just smoke-plane-split-p3b` (the data plane is rejected with `42501`
when it tries to write `events` / `cost_records`).

## Where the run stopped — the harness-integration frontier

The run halted at the **harness frontier** (still unbuilt; this is the resume
point — see `docs/roadmap/forward-roadmap.md` §A):

1. **Workspace git-clone / worker→runner SSH auth.** The live failure was
   `All configured authentication methods failed`. The worker could not
   authenticate the workspace clone / runner SSH in the live path.
2. **The real write stage.** Driving a real `codex` / `claude` / `opencode`
   writer against the cloned workspace.
3. **Draft-PR push → CI poll (`tanren-ci.yml` via Actions) → review → Mergify
   merge** — the true close-out of the P3-0009 live demo.

## Config gotchas (read before you resume)

- **`tanren orgs config-set` REPLACES the whole config.** The PATCH endpoint
  validates the supplied body against `OrgConfigV1` and persists _that whole
  object_ (`migrateOrgConfig(parsed.data.config)` in
  `services/orchestrator/src/routes/orgs/index.ts`) — it is **not** a deep
  merge. Always send the _complete_ config you want, or you will silently drop
  fields (e.g. the audit gate). Unknown fields are rejected with `400`.

- **Credential ref namespace:** org-scoped credentials live under
  `credential/<slug>/org/<orgId>/<name>` (personal under
  `credential/<slug>/me/<userId>/<name>`). The orchestrator **derives** the ref
  server-side from the authenticated `{kind, scope, ownerId}` plus a caller
  name; a caller-supplied ref naming a _different_ tenant is rejected with a
  `400`. Import through the org-scoped surface
  (`POST /orgs/:orgId/credentials`), not the legacy top-level routes.

- **In-memory credential registry limitation.** The default
  `InMemoryCredentialRegistry` is a `Map` that does **not** survive an
  orchestrator restart, and the legacy top-level import endpoints write to the
  secret store _without_ a registry `put`. A credential imported through the
  legacy routes — or imported before a restart — will **not** appear in the
  credential LIST. Re-import through the org-scoped surface to populate the list.
  A durable registry needs a `SecretStore.list(prefix)` contract method (flagged
  in the registry source); it is a follow-up, **not** an RLS scoping bug.

- **Fresh / reset dev DB.** Migration `0026` makes `org_id` NOT NULL on the core
  tables; a dev volume created before it cannot be backfilled in place. A live
  run needs a fresh or reset dev DB (`just down-dev` then `just up-dev`).

- **Prod role passwords.** Migrations `0029` / `0030` / `0031` create the
  `tanren_app` / `tanren_system` / `tanren_dataplane` roles with DEV/CI default
  passwords. Production rotates each out-of-band and supplies it via the runtime
  `DATABASE_URL` / `TANREN_SYSTEM_DATABASE_URL` / `TANREN_DATAPLANE_DB_PASSWORD`.

## How to resume

1. Bring up a fresh dev DB and the stack (`docs/operator-guide/operator-driven-run.md`).
2. Import credentials through the org-scoped surface.
3. Fix the worker→runner SSH auth (item 1 above) so the workspace clone
   succeeds — this is the first blocker.
4. Drive the real writer, push the draft PR, and poll CI → Mergify merge.
