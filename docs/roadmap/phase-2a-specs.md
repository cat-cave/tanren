# Phase 2A Specs

Detail entries for the 20 Phase 2A specs. Phase 2A is the operator backend and contracts block; no user-visible UI changes ship here. Scope framing, decision record, dependency graph, workflow inventory, prep notes, parallelization plan, and exit criteria are in `ROADMAP.md`.

### P2A-0001 — phase1-closeout-docs

**Owns**: `docs/operator-guide/**` new sections, `docs/playbooks/phase1-stack-lessons.md`, `docs/architecture/README.md` only for Phase 1 boundary notes.
**Consumes**: Phase 1 live proof.
**Produces**: operator-readable Phase 1 closeout and an operator-guide skeleton that Phase 2 specs can extend.

**What**: Convert the Phase 1 closeout notes into operator-facing documentation: how the existing Phase 1 loop runs end-to-end, what the live proof demonstrates, what is not yet operator-controlled, and what each Phase 2A/2B spec will change.
**Why**: Phase 2 specs assume a documented baseline; without it, Phase 2A/B reviewers cannot tell what is new from what already worked.
**How**: Capture Phase 1 stack lessons under `docs/playbooks/`, expand `docs/operator-guide/README.md` with a current-state section that links to the fixture-easy proof and a Phase 2 spec table, and reference `docs/audits/phase2-readiness.md` as the backlog input.

**Test plan**: `corepack pnpm run format:check`, `corepack pnpm run lint`, link-check the new docs.
**Quality bar**: no operator-facing claim that contradicts the audit; every "will be added" claim points at a specific P2A or P2B spec.
**Real-functionality validation**: a new contributor can read the docs and understand what Phase 1 produced without running the smoke test.
**Worktree-isolation safety**: docs-only; touches no schema, runtime, or CLI surfaces.

### P2A-0002 — phase2-workflow-inventory

**Owns**: `docs/design/operator-flows/**` (low-fi wireframe imports), `docs/design/acceptance-criteria/**`, the workflow-inventory section of this file.
**Consumes**: P2A-0001 and the existing low-fi wireframes held outside the repo.
**Produces**: a frozen, reviewable acceptance-criteria set for every operator surface 2B will build, plus the low-fi artifacts they reference.

**What**: Import the existing low-fi wireframes as source-of-truth artifacts under `docs/design/operator-flows/**` and author one acceptance-criteria markdown per operator surface (onboarding, credentials, project setup, spec submission, run detail, history/costs, settings, failure recovery).
**Why**: 2B implementation needs frozen acceptance criteria before hi-fi lands. The workflow inventory must be artifacted in the repo, not held externally.
**How**: Drop low-fi PDFs/PNGs/SVGs into `docs/design/operator-flows/`, add one acceptance-criteria markdown per surface, cross-link each to the responsible 2A or 2B spec.

**Test plan**: `corepack pnpm run format:check`, lint markdown, manual review that every surface has acceptance criteria and an owning 2B spec.
**Quality bar**: no 2B spec ships without a referenced acceptance-criteria file; no acceptance criteria reference a feature deferred to Phase 3.
**Real-functionality validation**: opening any low-fi flow links to a markdown acceptance file and an owning 2B spec.
**Worktree-isolation safety**: design artifact import only; no code changes.

### P2A-0003 — operator-auth-control-plane

**Owns**: `services/orchestrator/src/auth/**`, `services/orchestrator/src/routes/auth/**`, `services/orchestrator/src/middleware/**`, `db/src/schema.ts` and migrations for `organizations`, `org_members`, `users`, `sessions`, and `project_members`, `services/dashboard/src/auth/**`, `cli/src/auth/**`, `docs/operator-guide/auth.md`.
**Consumes**: P2A-0001 and the Phase 1 baseline.
**Produces**: a multi-user authentication and authorization substrate with **organization as the top-level tenant** (= GitHub org), GitHub OAuth as the first identity provider, and an explicit extension contract for OIDC providers (Authentik first, others later).

**What**: Add organizations, org_members, users, sessions, and project_members tables; implement GitHub OAuth sign-in for the dashboard; bind each user to their GitHub identity and to one or more orgs by GitHub org membership; create one Tanren organization row per linked GitHub org; gate every orchestrator HTTP route on session or token; scope every existing project/spec/run query by org membership and project membership; expose a session cookie and an API-token grant for the CLI. Localhost-only binding in the dev profile; no anonymous access in the prod profile.
**Why**: PROJECT_BRIEF §5.2 places `tenant_id` and `user_id` in the v0 schema from day one; the audit flags the unauthenticated control plane as critical. The hi-fi treats the GitHub org as a first-class tenant (top bar org pill, "your github org is your tanren org" promise in onboarding). Phase 2 dashboards expose live runs, costs, credentials, and PR state, so authn and authz must precede every user-visible UI.
**How**: Define an `IdentityProvider` interface implemented by `GitHubOAuthProvider` first, with a documented extension contract for `OidcProvider` (Authentik) and a `LocalDevProvider` used in tests. Persist users by stable identity-provider subject; never store provider tokens beyond what is needed for email/org verification. Sessions are HTTP-only cookies with CSRF tokens for state-changing routes. CLI uses long-lived API tokens scoped to a user. Every repository function takes an `actorContext` argument carrying `(userId, orgId, projectId?, scope[])`; queries filter on the context.

**Test plan**: provider interface unit tests with a fake identity provider, session and CSRF unit tests, route-level authz tests, CLI token-flow tests, OAuth callback integration test against a recorded fixture, org-membership refresh tests, `corepack pnpm run check`.
**Quality bar**: no orchestrator route is reachable without a verified session or token; no project query bypasses org-or-project membership scoping; provider secrets live in Vault, never in env outside compose; the OIDC interface is exercised by at least one test even though the production provider does not ship in Phase 2; users created via one org cannot see another org's data without explicit membership.
**Real-functionality validation**: a fresh database is bootstrapped by the first GitHub OAuth sign-in creating both a user row and the user's GitHub org as an organization row, with the user as the first org admin; a second user signing in with membership in the same GitHub org joins that organization automatically and only sees the projects they are a member of within it.
**Worktree-isolation safety**: owns auth tables, auth routes, auth middleware, and the dashboard auth surface; does not own project/spec CRUD bodies beyond adding `actorContext` arguments.

### P2A-0004 — dev-prod-compose-split

**Owns**: `compose.dev.yml`, `compose.prod.yml`, `justfile` profile targets, `docs/operator-guide/deploy.md`, `scripts/vault-init/**`.
**Consumes**: P2A-0003.
**Produces**: a dev compose stack with no production-grade secret assumptions, and a prod compose profile that requires operator-provided secrets and exposes no host ports beyond the dashboard.

**What**: Split the single `compose.yml` into a dev profile and a prod profile. Dev keeps the current developer ergonomics (static Vault root token, exposed Postgres, exposed runner SSH, exposed orchestrator). Prod requires `VAULT_ROOT_TOKEN` and `POSTGRES_PASSWORD` from operator env, exposes only the dashboard, binds runner SSH to the internal network only, and forbids the Docker socket on any service outside the allocator (which P2A-0010 then narrows further).
**Why**: The audit flags static dev credentials and host-published service ports as critical for prod deployment.
**How**: Use compose `profiles` and per-environment env files, add `just up-dev` and `just up-prod` selectors, write a Vault-init script that creates per-service AppRoles and stores their credentials in a known path, document Vault token rotation in `docs/operator-guide/deploy.md`.

**Test plan**: `just up-dev` smoke (existing Phase 1 fixture run), `just up-prod` smoke against a throwaway Vault token (verifying no static fallback path), service-port assertions, `corepack pnpm run check`.
**Quality bar**: no static secret defaults reachable from the prod profile; no service except the dashboard publishes a host port in prod; cloudflared exposure is explicitly deferred to Phase 3.
**Real-functionality validation**: prod profile fails to start without operator-provided `VAULT_ROOT_TOKEN`; dev profile starts with no env config as today.
**Worktree-isolation safety**: owns compose, justfile, vault-init, and deploy docs; does not own orchestrator or runner code.

### P2A-0005 — typed-workflow-state-contract

**Owns**: `services/orchestrator/src/engine/state/**`, `services/orchestrator/src/engine/repositories/**`, `db/src/schema.ts` and migrations for state enums and check constraints, `services/orchestrator/tests/**state**`, lint rules under `oxlintrc.json` that forbid raw row casts in workflow code.
**Consumes**: P2A-0001.
**Produces**: Zod discriminated unions for run/spec/task/job/actor state, Drizzle enum columns and SQL check constraints generated from those unions, and typed repository helpers that replace raw SQL row casts.

**What**: Define Zod discriminated unions for each state type; generate matching Drizzle enums and SQL `CHECK` constraints; replace raw SQL row casts in workflow code with typed repository functions; add a typed transition helper that fails at compile time on invalid transitions.
**Why**: The audit lists stringly-typed state and scattered SQL casts as high-priority; Phase 2 API contracts (P2A-0014) cannot have stable shapes if the orchestrator itself ships untyped state strings.
**How**: Author Zod as source of truth; generate enum lists for Drizzle; write a codegen step under `scripts/` that emits the SQL `CHECK` clauses from the Zod schema and asserts no drift; replace existing inline casts with `RunStore`, `SpecStore`, `TaskStore`, `JobStore`, and `ActorStore` modules.

**Test plan**: state-transition unit tests, drift check between Zod and SQL, lint rule preventing reintroduction of raw casts, migration tests against fresh DB and an in-place dev DB, `corepack pnpm run check`.
**Quality bar**: no `as` cast on database rows in workflow code; all state values flow through repository decoders; transitions disallowed by Zod are disallowed by SQL.
**Real-functionality validation**: the Phase 1 fixture flow runs end-to-end through the typed stores without behavior change.
**Worktree-isolation safety**: owns state types, repositories, and state-related schema changes; does not own non-state schema or workflow business logic beyond replacing casts.

### P2A-0006 — versioned-project-config

**Owns**: `services/orchestrator/src/engine/config/projectConfig.ts`, `services/orchestrator/src/engine/config/orgConfig.ts`, `db/src/schema.ts` and migrations for the `projects.config` and `organizations.config` column shapes and versions, `services/orchestrator/tests/**projectConfig**`, `docs/operator-guide/project-config.md`.
**Consumes**: P2A-0005 and P2A-0003.
**Produces**: a versioned Zod schema for org-level and project-level config covering the **6-role × fallback-chain routing table**, retry budgets / escape hatches, allocator settings, notification target refs, credential refs, governance posture, and Forge persona, plus a forward-compatible migration helper.

**What**: Define top-level `OrgConfigV1` and `ProjectConfigV1` Zod schemas. The routing table is `Record<RoleId, { chain: RoutingChainEntry[] }>` where `RoleId ∈ {plan, write, check, audit, demo, forge}` and `RoutingChainEntry = { cli, model, authRef, healthHint? }`. Even when v0 only has Codex entries, every role's chain is stored as an array — the schema does not change when Claude and opencode arrive in Phase 3. Write a parser that validates stored config against the current version, write a forward-migration helper for future `V2`+, store the discriminator `version` field, and remove every `Record<string, unknown>` from config code. Phase 2 writes config to DB only; the optional `tanren-config`-repo audit-gate write path is Phase 3.
**Why**: Audit high-priority. Phase 2B's project/spec/settings/onboarding UIs cannot render or edit config without a typed schema. The 6-role fallback-chain shape is the hi-fi's settings UI's data model; getting it right now avoids a Phase 3 schema break when additional providers arrive.
**How**: Zod is the single source; the runtime parser is consumed directly and a JSON Schema artifact is generated for documentation only. Document the migration policy (additive fields default in code; breaking changes bump `version`). Document the principled config bucketing: only this config lives in DB; `.github/workflows/tanren-ci.yml`, `.mergify.yml`, and `CODEOWNERS` live in the target repo (Tanren reads them at link time but doesn't author them in Phase 2). The `tanren-config`-repo audit-gate write path is named here but explicitly scoped to Phase 3.

**Test plan**: parser unit tests, version-migration tests, golden-fixture tests for current project rows, drift test against the Phase 1 fixture project config, fallback-chain shape tests with empty / single-entry / multi-entry chains, `corepack pnpm run check`.
**Quality bar**: project and org config are never read as `unknown`; unknown fields cause parse failure with a typed error; all 6 roles are represented in the routing schema even if their chains are empty in v0; Codex-only v0 stores routing as a chain not as flat assignments.
**Real-functionality validation**: the Phase 1 fixture project loads under `ProjectConfigV1` with its existing plan/write/check/audit routes expressed as single-entry chains; new demo and forge roles default to empty chains and degrade gracefully.
**Worktree-isolation safety**: owns the project + org config schemas and parsers; touches project/org routes only for parse-call wiring.

### P2A-0007 — event-payload-schemas

**Owns**: `services/orchestrator/src/engine/events/**`, `db/src/schema.ts` and migrations for `events.payload` typing and indexing, `services/orchestrator/tests/**events**`.
**Consumes**: P2A-0005.
**Produces**: a typed event map mapping each event name to a Zod payload schema with **semantic-rich fields the Forge narration layer consumes**, a generic typed append helper, and decoder helpers for downstream consumers.

**What**: Replace `unknown` event payloads with a typed event-name → Zod-schema map. The append helper accepts only known names with matching payloads. Decoder helpers expose typed iterators for API consumers. Sensitivity tags on payload fields feed the redaction layer in P2A-0009. Event payloads explicitly carry the semantic fields a Forge narration layer renders: writer events carry `intent` (declared rationale), `decisions` (structured per-call decisions), `toolCalls` (structured invocations with args + summarized outputs); planner events carry subtask rationale; checker/auditor events carry verdict reasoning. The hi-fi run-detail "writer's reasoning" pane is rendered directly from these fields.
**Why**: P2A-0014 (read API), the P2B dashboards, and the Forge narration substrate (P2A-0019) consume events. Without typed payloads, the API contract cannot be stable and parse errors surface as runtime crashes in the UI. Without semantic richness, the thin v0 Forge narration has nothing to render and thick Phase 3 Forge needs to re-derive context.
**How**: Centralize the event map in `events/registry.ts`; emit a TypeScript discriminated union from Zod; tag fields with `Sensitivity` annotations for the redaction layer; generate documentation for each event name. Codex-emitted JSONL events are parsed into the typed semantic fields at write time, not re-parsed later.

**Test plan**: append-helper compile-error tests, decoder tests on existing Phase 1 fixture events, payload-shape lints, semantic-field round-trip tests for writer/planner/checker/auditor events, `corepack pnpm run check`.
**Quality bar**: no `JSON.parse` on event payloads in business code; no inline event-name strings outside the registry; every payload field has a sensitivity tag; writer events carry structured intent/decisions/toolCalls (not raw stdout strings).
**Real-functionality validation**: replaying the Phase 1 fixture run's events through the typed decoders produces a typed timeline with the writer reasoning pane renderable end-to-end from event fields alone (no re-derivation from stdout).
**Worktree-isolation safety**: owns event registry, append helpers, and event-related schema; does not own event producers beyond the parser hooks needed to populate semantic fields.

### P2A-0008 — answerer-schema-single-source

**Owns**: `services/orchestrator/src/engine/answerers/schemas/**`, `services/orchestrator/tests/**answererSchema**`, `scripts/answerer-schema-export.ts`.
**Consumes**: P2A-0005 and P2A-0018.
**Produces**: Zod as the single source for **all five Answerer schemas** (plan, check, audit, demo, forge), with generated JSON Schema files committed and used by `codex exec --output-schema`, plus a golden contract test verifying no drift.

**What**: Consolidate Zod/JSON Schema duplication for the existing checker and auditor schemas, and add new schemas for plan (subtask list), demo (spec-completion narration), and forge (turn output for the conversation substrate, with typed tool-call shapes). Generate JSON Schema at build time and commit the output. Add a contract test that fails if regenerated JSON Schema differs from the committed copy. Plan schema is consumed by P2A-0012; demo + forge schemas are consumed by P2A-0019.
**Why**: Audit high-priority. Duplicated schemas drift; with five Answerer roles in v0 (plan, check, audit, demo, forge), the drift risk compounds. Forge specifically needs a stable schema before its tool-call surface is wired up.
**How**: Use `zod-to-json-schema`; the codegen step runs as part of `pnpm check`; existing answerer execution paths read the committed JSON Schema file path for `codex exec --output-schema`. Forge's schema includes the tool-call discriminated union defined by P2A-0019.

**Test plan**: drift test, parser tests, regression test against Phase 1 fixture answers, schema-round-trip tests for plan/demo/forge, `corepack pnpm run check`.
**Quality bar**: no hand-authored JSON Schema for Answerers in the repo; drift is a hard CI failure; all five Answerer roles have schemas committed in Phase 2.
**Real-functionality validation**: Phase 1 fixture checker and auditor results validate against the regenerated schemas unchanged; a synthetic plan/demo/forge response validates against its schema.
**Worktree-isolation safety**: owns answerer schemas; does not own answerer execution.

### P2A-0009 — redaction-access-scope

**Owns**: `services/orchestrator/src/engine/redaction/**`, `services/orchestrator/src/routes/**` redaction serializer wrappers, `db/src/schema.ts` and migrations for access-scope columns where applicable, `services/orchestrator/tests/**redaction**`.
**Consumes**: P2A-0003 and P2A-0007.
**Produces**: a central redaction layer that stores raw event, log, and error payloads but redacts on read according to actor access scope, with audit events on raw access.

**What**: Build a redaction pipeline that operates at API/serialization time, not at write time. Events, provider errors, SSH stdout/stderr, URLs, credential refs, auth JSON, and high-entropy tokens are stored raw and gated behind access scopes (`project:member`, `project:admin`, `platform:admin`). The default API surface returns redacted; raw access requires elevated scope and emits a `redaction.raw_access` audit event.
**Why**: PROJECT_BRIEF treats the event log as a compliance substrate; the audit demands centralized redaction. Storing raw preserves later forensic analysis; redact-on-read keeps the dashboard safe by default.
**How**: Lean on the `Sensitivity` tags in P2A-0007; redact via a serializer that consults actor scope; raw access emits `redaction.raw_access` events; document allowed access-scope progressions in operator docs.

**Test plan**: redaction-pattern unit tests, scope-based serialization tests, raw-access audit-event tests, golden fixtures for the Phase 1 fixture events, `corepack pnpm run check`.
**Quality bar**: no API path returns raw payloads without an actor-scope check; no log/SSH/error path bypasses the redaction serializer; raw access is auditable.
**Real-functionality validation**: Phase 1 fixture events read by a project member return redacted forms; the same events read by a platform admin return raw with an audit trail.
**Worktree-isolation safety**: owns the redaction module and serializer wrappers; access-scope columns added in concert with P2A-0003 acceptance.

### P2A-0010 — runner-allocator-isolation

**Owns**: `services/allocator/**` (new service), `services/orchestrator/src/engine/allocators/**` only for client cutover, `runner/**` for image and profile changes, `compose.dev.yml` and `compose.prod.yml` for the new sidecar, `services/orchestrator/tests/**allocator**`, `docs/operator-guide/runners.md`.
**Consumes**: P2A-0004 and P2A-0005.
**Produces**: a narrow allocator sidecar service that owns the Docker socket, per-run ephemeral runner containers, internal-only SSH in prod, and a finalizer that wipes workspaces and Codex auth on success and failure.

**What**: Move the Docker socket out of the orchestrator and into a new `allocator` container. The allocator exposes an internal HTTP API for `allocate` and `release` only. Per-run runners are ephemeral (created on allocate, destroyed on release with a TTL fallback for abandoned runs). SSH binds to the internal docker network in prod. Workspaces and `CODEX_HOME` are wiped on release.
**Why**: Audit high-priority items (Docker socket exposure, broad runner isolation, no cleanup finalizer) collapse into one coherent surface; splitting them would cause repeated runner image churn.
**How**: New allocator service with a minimal API; the orchestrator allocator client calls it instead of opening the Docker socket; the runner image gets a per-run scratch volume; the release path runs the finalizer; an abandoned-run sweeper job claims a heartbeat.

**Test plan**: allocator API unit tests, cleanup-finalizer tests with simulated crashes, abandoned-run TTL tests, compose smoke for prod profile, runner-image rebuild test, `corepack pnpm run check`.
**Quality bar**: the orchestrator container has no Docker socket mount; no host port for runner SSH in prod profile; no workspace or `CODEX_HOME` survives a successful or failed release.
**Real-functionality validation**: a Phase 1 fixture run completes under the new allocator with verified clean state after release; a crashed run is reclaimed by the TTL sweeper.
**Worktree-isolation safety**: owns the allocator service, allocator clients, runner image, and runner-related compose changes; does not own workflow business logic.

### P2A-0011 — cost-record-persistence

**Owns**: `services/orchestrator/src/engine/costs/**`, `db/src/schema.ts` and migrations for cost records and sources, `services/orchestrator/tests/**costs**`, `docs/operator-guide/costs.md`.
**Consumes**: P2A-0005 and P2A-0007.
**Produces**: mandatory cost-record persistence for every real Codex planner/writer/checker/auditor call, attributed to one of the three v0 cost models with no unknown-source fallback.

**What**: Make cost resolution mandatory at task completion. Parse Codex usage events, attribute them to a cost source (`provider_direct`, `codexbar`, `opportunity_computed`), persist a `cost_records` row, and fail or escalate when usage cannot be attributed. Persist subscription-window denominators so estimates refine over time.
**Why**: PROJECT_BRIEF §4 makes cost a v0 invariant; the audit lists cost persistence as high. P2B-0005 (history and costs) reads these rows directly.
**How**: Define a `CostSource` discriminated union, write a `CostRecorder` that runs at task completion, fail tasks with a typed `cost.unattributable` error if usage cannot be sourced, persist subscription-window denominators for refinement.

**Test plan**: attribution unit tests for each cost source, unattributable-failure tests, migration tests, regression test against Phase 1 fixture usage events, `corepack pnpm run check`.
**Quality bar**: no completed task without a cost record; no unknown-source row.
**Real-functionality validation**: replaying the Phase 1 fixture run produces cost records with explicit sources for every planner/writer/checker/auditor call.
**Worktree-isolation safety**: owns cost recording; does not own provider invocation beyond reading their usage outputs.

### P2A-0012 — planner-feedback-loops

**Owns**: `services/orchestrator/src/engine/workflow/planner/**`, `services/orchestrator/src/engine/workflow/checker/**` (rejection-loop branch), `services/orchestrator/src/engine/workflow/auditor/**` (rejection-loop branch), `db/src/schema.ts` and migrations for subtask state, `services/orchestrator/tests/**plannerLoop**`.
**Consumes**: P2A-0005, P2A-0008, and P2A-0011.
**Produces**: a real Planner task that emits subtasks, persisted subtask state, checker-rejection loop, and auditor-rejection loop with retry budgets.

**What**: Replace the Phase 1 single-pass write→check→audit with a real Planner step that emits a typed subtask list, persists subtasks, executes them sequentially, loops back to the Planner on checker or auditor rejection up to a configurable retry budget, and escalates on budget exhaustion.
**Why**: PROJECT_BRIEF §2 makes the planner and rejection loops part of the minimum viable workflow; the audit calls this out as high. P2B-0004 (run detail) displays the subtask timeline.
**How**: Planner uses Codex as the v0 default with a Zod-typed subtask schema (Phase 3 will add Claude); subtask runners reuse the Phase 1 writer/checker/auditor surface; rejection loops re-invoke the Planner with the rejection reason. Retry budget read from project config (P2A-0006).

**Test plan**: planner schema tests, multi-subtask integration tests, rejection-loop tests, budget-exhaustion escalation tests, opt-in live smoke against the fixture-easy repo, `corepack pnpm run check`.
**Quality bar**: no synthetic single-pass workflow path remains in real runs; every rejection is recorded with reason and producer; retry budget is enforced from project config.
**Real-functionality validation**: a fixture spec requiring multi-file changes produces multiple subtasks and at least one rejection-loop run completes successfully end-to-end.
**Worktree-isolation safety**: owns the planner/checker/auditor loop surfaces and subtask schema; does not own provider adapters beyond the Planner.

### P2A-0013 — project-spec-cli-api

**Owns**: `services/orchestrator/src/routes/orgs/**`, `services/orchestrator/src/routes/projects/**`, `services/orchestrator/src/routes/specs/**`, `services/orchestrator/src/routes/credentials/**`, `services/orchestrator/src/routes/doctor/**`, `cli/src/commands/orgs/**`, `cli/src/commands/projects/**`, `cli/src/commands/specs/**`, `cli/src/commands/credentials/**`, `services/orchestrator/tests/**routes**`, `docs/operator-guide/cli.md`.
**Consumes**: P2A-0003, P2A-0006, P2A-0018.
**Produces**: a CRUD HTTP API and CLI surface for orgs, projects, specs, behaviors, milestones, personas, credential references, and a `/doctor` health endpoint, gated by operator auth and authorization.

**What**: Expose typed HTTP routes for org, project, spec, behavior, milestone, persona, and credential-reference CRUD; mirror them via CLI commands; persist credential references (not values) through Vault; expose a `/doctor` JSON endpoint that mirrors the existing `tanren doctor` CLI output (stack health, Vault health, runner health, GitHub reachability). Reuse Zod schemas as request/response contracts. Brownfield "link repo" endpoint accepts an org+repo identifier, verifies the GitHub App has access, reads existing `.github/workflows/tanren-ci.yml`, `.mergify.yml`, and `CODEOWNERS` if present (does not write any files), and creates the project row.
**Why**: P2B-0002 (onboarding), P2B-0003 (project + spec UI), and P2B-0008 (failure recovery) all depend on this contract; Phase 2 cannot be operator-driven without a real CLI/API in place of hand-poked DB rows. `/doctor` over HTTP is the dashboard onboarding stack-health card's data source.
**How**: Routes share Zod schemas with P2A-0006 and P2A-0018; the CLI uses API tokens from P2A-0003; credential CRUD writes references and stores values in Vault per the P2A-0004 prod profile policy; `/doctor` reuses the existing CLI implementation.

**Test plan**: route unit tests, CLI command tests, authz tests, Vault-backed credential CRUD smoke, brownfield-link smoke against the existing fixture-easy repo, `/doctor` JSON shape test, `corepack pnpm run check`.
**Quality bar**: no DB-poking path required for operator workflows; credential values never traverse the API in responses; all routes scoped by org-or-project membership; brownfield link never writes to the target repo in Phase 2.
**Real-functionality validation**: an operator can sign in, link an existing GitHub repo as a project, import a Codex credential reference, attach a spec to a milestone, declare a behavior, and trigger a run end-to-end via CLI or API with no manual DB writes; `/doctor` returns the same stack-health information the CLI does.
**Worktree-isolation safety**: owns org, project, spec, behavior, milestone, persona, credential, and doctor routes and CLI commands.

### P2A-0014 — run-detail-api-contract

**Owns**: `services/orchestrator/src/routes/runs/**`, `services/orchestrator/src/routes/events/**`, `services/orchestrator/src/routes/costs/**`, `services/orchestrator/tests/**runRoutes**`, `docs/contracts/run-detail-api.md`.
**Consumes**: P2A-0005, P2A-0007, P2A-0009, P2A-0011, and P2A-0002.
**Produces**: the read API contract that 2B dashboard surfaces consume — run summary, task timeline, event stream, costs, PR/CI state, failure diagnostics — with redaction and pagination.

**What**: Define and ship the run-detail read API. Server-sent events for live updates, cursor-based pagination for event lists, redacted-by-default payloads via P2A-0009. Contract artifact published under `docs/contracts/`.
**Why**: Dashboard hi-fi screens read this contract; freezing it in 2A keeps 2B parallelizable per screen.
**How**: One route per surface, Zod request/response schemas, SSE stream for live runs, contract tests against Phase 1 fixture runs.

**Test plan**: contract tests, SSE update tests, pagination tests, redaction-scope tests, `corepack pnpm run check`.
**Quality bar**: contract is frozen at spec exit; changes require an addendum; no UI-specific shaping leaks into the API.
**Real-functionality validation**: replaying the Phase 1 fixture run through the API produces a complete timeline, cost list, and event stream that match acceptance criteria from P2A-0002.
**Worktree-isolation safety**: owns read API routes and contract docs; does not own dashboard rendering.

### P2A-0015 — executable-acceptance-gate

**Owns**: `scripts/acceptance/**`, `justfile` acceptance targets, the existing fixture repo `cat-cave/tanren-fixture-easy`, the new fixture repo `cat-cave/tanren-fixture-medium` (created by this spec), `services/orchestrator/tests/**acceptance**`, `docs/operator-guide/acceptance.md`.
**Consumes**: P2A-0012, P2A-0013, P2A-0014, and P2A-0011.
**Produces**: a `just acceptance` command that runs the easy and medium fixture repos through the real workflow end-to-end and asserts persisted outcome plus cost attribution.

**What**: Implement `just acceptance-easy` and `just acceptance-medium`. Easy reuses the Phase 1 fixture (single-file change, single subtask, no rejection loop). Medium creates a new fixture repo whose spec genuinely exercises the new Phase 2 capabilities: multi-file changes (e.g. add a function, update its tests, update a README), forcing multi-subtask Planner output and at least one checker-rejection loop. Each command asserts `outcome = 'phase2_<tier>_complete'`, persisted PR URL, CI passing, cost records covering planner/writer/checker/auditor, and clean runner state.
**Why**: PROJECT_BRIEF §14 demands an executable acceptance gate; the audit lists it as critical. Local-only execution (not GitHub Actions) keeps live Codex and GitHub credentials out of CI secrets, matching the Phase 0/1 pattern.
**How**: Use the fixture-easy repo unchanged; create fixture-medium with a planner-forcing spec; reuse the Phase 1 live-validation env-var pattern (`TANREN_CODEX_AUTH_JSON_FILE`, `TANREN_GITHUB_TOKEN_FILE`, `TANREN_GITHUB_REPO_URL`); persist proofs into ROADMAP.

**Test plan**: dry-run smoke with fake providers, opt-in live `just acceptance-easy`, opt-in live `just acceptance-medium`, `corepack pnpm run check`.
**Quality bar**: acceptance failure on any persisted-state criterion is a release block; the gate does not require GitHub Actions credentials; the hard tier is named in Phase 3 and out of scope here.
**Real-functionality validation**: both fixture tiers produce draft PRs whose CI passes, with persisted multi-task state and full cost attribution.
**Worktree-isolation safety**: owns acceptance scripts, the fixture-medium repo content, and acceptance docs; does not own workflow code paths beyond reading them.

### P2A-0016 — design-system-import

**Owns**: `docs/design/tokens/**`, `services/dashboard/src/design/**` (token-consuming package surface), `services/dashboard/package.json` for token consumption only.
**Consumes**: external design tokens delivered at the 2A→2B boundary.
**Produces**: design tokens imported as repo artifacts and exposed to the dashboard build, with no global restyle in the same change.

**What**: Land the design tokens under `docs/design/tokens/**` as source-of-truth artifacts and expose them to the dashboard build via a small `services/dashboard/src/design/` package that re-exports CSS variables and TypeScript constants. Do not restyle any existing dashboard surface in this spec.
**Why**: Phase 2 prep notes require tokens to be repo-resident before user-visible 2B work and forbid bundling a restyle with the import.
**How**: Tokens delivered as JSON; codegen emits CSS variables and a TypeScript module; existing dashboard surfaces continue to use their current inline styles.

**Test plan**: token-codegen drift test, dashboard build test, lint, `corepack pnpm run check`.
**Quality bar**: no dashboard surface visually changes in this spec; tokens are the only new asset.
**Real-functionality validation**: dashboard builds with tokens imported but unchanged appearance.
**Worktree-isolation safety**: owns design tokens and the dashboard design package; does not modify any rendering code.

### P2A-0017 — notifications-contract

**Owns**: `services/orchestrator/src/engine/notifications/**`, `db/src/schema.ts` and migrations for `notification_targets` and `notification_routes`, `services/orchestrator/tests/**notifications**`, `docs/operator-guide/notifications.md`.
**Consumes**: P2A-0007, P2A-0011, and P2A-0006.
**Produces**: a **full per-event × per-channel × severity matrix schema** with org defaults + dev-layered overrides, an interface that admits all hi-fi channels (slack, github-checks, ntfy, teams, discord, email, twilio, pagerduty, webhook), and a v0 implementation that only wires ntfy.

**What**: Define the notification routing matrix exactly as the hi-fi specifies it: rows are event names from the P2A-0007 registry tagged with a severity (`ok` / `info` / `warn` / `fail`), columns are channel kinds, cells are boolean opt-ins, with separate org-default and dev-override layers. Persist `notification_targets` (one row per configured channel destination) and `notification_routes` (one row per event × target opt-in). Auto-mute-on-weekends is a per-target option. Ship a dispatcher interface; implement only the ntfy channel in Phase 2. Slack, GitHub Checks, and the rest of the channels are schema-only stubs whose UI rows render as "configured but not yet wired" in v0.
**Why**: PROJECT_BRIEF §12.3 requires escalation. The hi-fi's matrix is the operator surface; getting the schema right in Phase 2 means Phase 3 channel-adapter work is a pure addition with no schema migration. Thin v0 implementation keeps the surface area honest while the matrix UI in P2B-0002 is fully functional against the schema.
**How**: One module per channel kind implementing a `NotificationChannel` interface; only ntfy registered in v0. Dispatcher reads new events, evaluates the matrix against the event's severity and the targets opted in, calls the channel interface; failures are logged but do not block the workflow. Payloads pass through the P2A-0009 redaction layer before publish.

**Test plan**: matrix evaluation unit tests, ntfy integration smoke, dev-override layering tests, weekend-mute tests, channel-interface stub tests for each future channel, `corepack pnpm run check`.
**Quality bar**: notifications never block workflow progress; payloads pass through the redaction layer; the matrix shape supports all hi-fi channels without schema migration; v0 ships only ntfy and explicitly marks other rows as unwired.
**Real-functionality validation**: a failed Phase 1 fixture run produces an ntfy notification visible in the compose stack via the matrix evaluation path; the same event evaluates correctly against a synthetic slack-enabled matrix even though slack is unwired.
**Worktree-isolation safety**: owns the notifications module, target+route tables, and the channel-interface contract; does not own dashboard rendering of the matrix.

### P2A-0018 — product-entities-contract

**Owns**: `services/orchestrator/src/engine/entities/**`, `db/src/schema.ts` and migrations for `organizations`, `personas`, `behaviors`, `milestones`, `spec_behaviors`, `spec_milestones`, `spec_dependencies`, `services/orchestrator/tests/**entities**`, `docs/architecture/product-entities.md`.
**Consumes**: P2A-0005 and P2A-0003.
**Produces**: the persistent **product information model** the hi-fi's vision is built on — Persona → Behavior → Spec, with Specs grouped by Milestone and connected by directed dependency edges.

**What**: Define Zod schemas and persist tables for: `personas` (org-scoped or project-scoped, with name + description), `behaviors` (owned by persona, given/when/then fields, plus a stable id), `milestones` (project-scoped, ordered, with optional eta), `spec_behaviors` (many-to-many: a spec demonstrates ≥1 behavior), `spec_milestones` (many-to-one: a spec belongs to a milestone), `spec_dependencies` (directed spec→spec edges with cycle detection). Specs link to behaviors and milestones from creation onward. CRUD routes for these entities ship as part of P2A-0013. Authoring UIs ship partially in Phase 2B (spec creation form can select milestones and tag behaviors) and fully in Phase 3 (Forge interview, DAG canvas authoring).
**Why**: The hi-fi consistently uses these entities — every spec on the DAG canvas is tied to behaviors, every project view talks about milestones, the velocity card cites ETA against milestones. Even though Phase 2 does not ship the DAG canvas, persisting these entities in Phase 2 lets v0 specs reference them and prevents a Phase 3 schema break when authoring UIs arrive. Per your direction: "structure properly now, even if from day one in Phase 2 it's not complete."
**How**: All entities are org-scoped at minimum; persona can be reused across projects in the same org. Behaviors are typed with given/when/then text fields plus a free-form description; check/audit Answerers can reference behavior ids in their input. Spec dependencies must be a DAG (cycle detection at insert). All tables seed empty for the Phase 1 fixture project; the fixture's existing specs link to a single default milestone and a single default behavior to keep v0 ergonomics simple.

**Test plan**: schema unit tests, cycle-detection tests on `spec_dependencies`, fixture-project migration tests, CRUD round-trip tests, `corepack pnpm run check`.
**Quality bar**: every spec row has at least one milestone and one behavior referenced after migration (default-seeded for existing rows); dependency-edge cycles are rejected at insert with a typed error; the schema admits the hi-fi's full DAG canvas data shape without further migration.
**Real-functionality validation**: the Phase 1 fixture spec loads with linked default milestone and default behavior; a synthetic multi-spec scenario can be constructed where one spec depends on another and the DAG read API (P2A-0014) returns the edges.
**Worktree-isolation safety**: owns entity tables, entity schemas, and entity routes only via P2A-0013 wiring; does not own authoring UI.

### P2A-0019 — forge-narration-and-tool-surface

**Owns**: `services/orchestrator/src/engine/forge/**`, `db/src/schema.ts` and migrations for `forge_turns` and `forge_threads`, `services/orchestrator/src/engine/forge/tools/**`, `services/orchestrator/tests/**forge**`, `docs/architecture/forge.md`.
**Consumes**: P2A-0005, P2A-0006, P2A-0007, P2A-0008, P2A-0011, P2A-0014, P2A-0018.
**Produces**: the **data substrate for the Forge Answerer role** — a `forge_threads` table for long-lived conversation threads, a `forge_turns` table for individual turns (operator question, Forge response, suggested actions), a typed **Forge tool surface** schema, read-only tool stubs implemented in v0, and a small set of operator-actionable write buttons (e.g. "open new spec", "trigger run", "rerun failed task") that route through P2A-0013.

**What**: Define a Forge thread as the unit of operator-Forge conversation scoped to an org and optionally a project, with turns persisted as ordered Zod-typed records. Each turn has a `source` (which event, cost record, insight, or thread-prior-turn triggered it), an `audience_scope` (project / org / dev / platform-admin) that gates redaction via P2A-0009, and a `render` payload that is either a templated narration block (v0) or an LLM-authored response (Phase 3). Define the Forge tool schema as a typed discriminated union: read-only tools (`tanren.read_spec`, `tanren.read_run`, `tanren.read_events`, `tanren.read_costs`, `tanren.read_behaviors`, `tanren.read_milestones`, `tanren.read_insights`, `repo.read_file`, `repo.grep`, `repo.read_issue`) and write actions (`tanren.create_spec`, `tanren.trigger_run`, `tanren.rerun_task`, `tanren.acknowledge_insight`). Implement the read-only tools as real HTTP endpoints reading existing P2A-0014/P2A-0011 data. Implement the write actions as small dashboard buttons that call the existing P2A-0013 routes — these are operator-initiated, not LLM-initiated, in v0. Ship a templated v0 turn generator that produces the hi-fi's narration blocks (project pulse, attention queue, suboptimal callouts) from existing data; no LLM consumer in Phase 2.
**Why**: Per your direction: Forge is thin in v0, but the foundation must support thick Forge later "without tremendous refactoring." Defining the threads + turns + tool surface in Phase 2 means thick Phase 3 Forge is a pure swap: the dashboard reads `forge_turns` the same way regardless of whether they were produced by a template or an LLM with tools. Defining the write actions as operator-button-driven in v0 lets the dashboard ship the "do this thing" CTAs from the hi-fi without needing an LLM to author them.
**How**: Zod schemas in `forge/schemas`; tool implementations in `forge/tools`; templated narration generator in `forge/narration/v0`. Turns are append-only; threads carry summary state. The Phase 3 LLM author will read prior turns + tool results from the same tables.

**Test plan**: turn append/read tests, redaction-scope tests on turn render payloads, tool-stub return-shape tests, narration template round-trip tests against fixture-easy run data, write-action authz tests, `corepack pnpm run check`.
**Quality bar**: turn payloads are typed; no narration logic bypasses the turn-append path; write actions are gated by P2A-0003 authz; the tool schema covers every read and write the hi-fi shows Forge offering as a suggestion.
**Real-functionality validation**: the dashboard project view renders its Forge attention queue and suboptimal callouts entirely from generated turns in `forge_turns`; the operator clicking "open run" in a turn's suggested actions opens the corresponding P2B-0004 page.
**Worktree-isolation safety**: owns Forge threads/turns tables, tool schemas, tool stubs, narration generators, and the write-action route wiring (which delegates to P2A-0013); does not own the dashboard rendering of turns.

### P2A-0020 — workflow-insights-contract

**Owns**: `services/orchestrator/src/engine/insights/**`, `db/src/schema.ts` and migrations for `workflow_insights` (computed-on-read cache), `services/orchestrator/tests/**insights**`, `docs/architecture/insights.md`.
**Consumes**: P2A-0007, P2A-0011, and P2A-0012.
**Produces**: the **suboptimal-callout insights** the hi-fi surfaces inline in project view and run detail — initial set: `retry_hotspot`, `model_mismatch`, `pace_anomaly`.

**What**: Define typed insight kinds: `retry_hotspot` (same writer × same spec retried ≥ N times within a window — derives from P2A-0012 retry data), `model_mismatch` (a spec class is being routed to a model whose cost per merged outcome is materially higher than a historically-passing cheaper model — derives from P2A-0011 cost records and P2A-0014 outcomes), `pace_anomaly` (an in-flight task is materially slower than the class average — derives from event timestamps in P2A-0007). Compute on-read (no scheduled job in v0). Cache results in `workflow_insights` for read efficiency. Each insight has typed actions the operator (or eventually thick Forge) can take, routed through P2A-0013 (e.g. `model_mismatch.switch_writer` reroutes the spec class to the cheaper model).
**Why**: The hi-fi's suboptimal callouts are the workflow-quality surface, and they're inline in every primary view. Without this contract, the dashboard either shows nothing or shows hand-coded fake data. The three insight kinds named here all derive from data Phase 2 already persists, so the contract is cheap. The hi-fi's `stuck` and `review_stall` insights defer to Phase 3 (depend on spec-dependency-chain analysis and review polling).
**How**: One pure-function `computeInsight(kind, context, db) → Insight[]` per kind. Read-time computation; the cache is an optimization, not a source of truth. Insights surface in P2B-0003 project view, P2B-0004 run detail, and as Forge turn sources via P2A-0019.

**Test plan**: per-kind unit tests with synthetic event/cost fixtures, end-to-end smoke against the Phase 1 fixture data (which by design produces zero insights — no retries, no model variance), regression tests if any thresholds change, `corepack pnpm run check`.
**Quality bar**: every insight is typed; no insight is computed from fake data; the action routing path exists for every action shown in the hi-fi; thresholds are documented and configurable per-org.
**Real-functionality validation**: a synthetic multi-run scenario (writer retries the same spec twice with different models) produces a `retry_hotspot` and a `model_mismatch` insight readable via the P2A-0014 API; the action "switch writer · this spec class" updates routing via P2A-0013.
**Worktree-isolation safety**: owns insight definitions and computation; surfaces through P2A-0014 and P2A-0019 without owning those.

## Phase 2A Dependency Graph (full)

```text
P2A-0001 phase1-closeout-docs ─┐
P2A-0002 phase2-workflow-inventory ─┤
                                    │
Security stack:
P2A-0003 operator-auth-control-plane (orgs + users + members + GitHub OAuth) ──┐
P2A-0004 dev-prod-compose-split ───────────────────────────────────────────────┤
                                                                               │
Typed-contracts stack:                                                         │
P2A-0005 typed-workflow-state-contract ──┐                                     │
P2A-0006 versioned-project-config (6-role fallback chains) ──────────────────┐ │
P2A-0007 event-payload-schemas (semantic-rich for forge narration) ──────────┤ │
P2A-0008 answerer-schema-single-source (6 roles) ────────────────────────────┤ │
P2A-0018 product-entities-contract (orgs/personas/behaviors/milestones/deps) ┤ │
                                                                             │ │
Runtime stack:                                                               │ │
P2A-0009 redaction-access-scope ──────────────────────────────────────────────┤ │
P2A-0010 runner-allocator-isolation ──────────────────────────────────────────┤ │
P2A-0011 cost-record-persistence ─────────────────────────────────────────────┤ │
P2A-0017 notifications-contract (full matrix schema, ntfy-only impl) ────────┘ │
                                                                                │
Workflow stack:                                                                 │
P2A-0012 planner-feedback-loops ───────────────────────────────────────────────┤
P2A-0019 forge-narration-and-tool-surface (turns, tools, stubs) ───────────────┤
P2A-0020 workflow-insights-contract (retry hotspot, model mismatch, pace) ─────┤
                                                                                │
Product API stack:                                                              │
P2A-0013 project-spec-cli-api (incl. /doctor + org/repo link) ─────────────────┤
P2A-0014 run-detail-api-contract ─────────────────────────────────────────────→┤
                                                                                ├─→ P2A-0015 executable-acceptance-gate
                                                                                │
P2A-0016 design-system-import ──── lands at 2A→2B boundary ────────────────────┘
```
